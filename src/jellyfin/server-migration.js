'use strict';

const { query, transaction } = require('../db');
const registry = require('./registry');
const planServers = require('./plan-servers');
const provisioning = require('./provisioning');

const OPEN_STATUSES = new Set(['pending', 'running']);
const FINAL_STATUSES = new Set(['succeeded', 'failed', 'rolled_back', 'rollback_failed']);

class ServerMigrationError extends Error {
    constructor(code, message, stage = null) {
        super(message);
        this.name = 'ServerMigrationError';
        this.code = code;
        this.stage = stage;
    }
}

function isTrial(plan) {
    return plan?.billing_interval === 'trial';
}

async function primaryAccount(customerId) {
    const result = await query(`
        SELECT ja.*,js.name AS server_name,js.slug AS server_slug,js.server_class,
               js.enabled AS server_enabled,js.health_status AS server_health
        FROM jellyfin_accounts ja
        JOIN jellyfin_servers js ON js.id=ja.server_id
        WHERE ja.customer_id=$1
        ORDER BY ja.is_primary DESC,ja.disabled ASC,js.enabled DESC,
                 COALESCE(ja.updated_at,ja.created_at) DESC
        LIMIT 1
    `, [customerId]);
    return result.rows[0] || null;
}

async function activeAccountCount(serverId) {
    const result = await query(`
        SELECT COUNT(*)::int AS count
        FROM jellyfin_accounts
        WHERE server_id=$1 AND disabled=FALSE
    `, [serverId]);
    return Number(result.rows[0]?.count || 0);
}

async function targetServerForPlan(plan, targetServerId) {
    const candidates = await planServers.eligibleServersForPlan(plan, { enabledOnly: true });
    return candidates.find(server => String(server.id) === String(targetServerId)) || null;
}

async function migrationForId(migrationId) {
    const result = await query(`
        SELECT m.*,
               src.name AS source_server_name,src.slug AS source_server_slug,
               dst.name AS target_server_name,dst.slug AS target_server_slug,
               sa.jellyfin_username AS source_username,
               ta.jellyfin_username AS target_username,
               COALESCE(NULLIF(c.display_name,''),u.username,c.email,'Customer') AS customer_name
        FROM customer_server_migrations m
        JOIN customers c ON c.id=m.customer_id
        LEFT JOIN app_users u ON u.id=c.user_id
        JOIN jellyfin_servers src ON src.id=m.source_server_id
        JOIN jellyfin_servers dst ON dst.id=m.target_server_id
        JOIN jellyfin_accounts sa ON sa.id=m.source_account_id
        LEFT JOIN jellyfin_accounts ta ON ta.id=m.target_account_id
        WHERE m.id=$1
    `, [migrationId]);
    return result.rows[0] || null;
}

async function preflight(customerId, targetServerId, { expectedSourceAccountId = null } = {}) {
    const entitlement = await provisioning.currentEntitlement(customerId);
    if (!entitlement) throw new ServerMigrationError('NO_ACTIVE_ENTITLEMENT', 'Customer has no active entitlement to migrate.', 'preflight');

    const source = await primaryAccount(customerId);
    if (!source) throw new ServerMigrationError('NO_SOURCE_ACCOUNT', 'Customer has no Jellyfin account to migrate.', 'preflight');
    if (expectedSourceAccountId && String(source.id) !== String(expectedSourceAccountId)) {
        throw new ServerMigrationError('SOURCE_CHANGED', 'The customer\'s current Jellyfin account changed after the migration was previewed.', 'preflight');
    }
    if (!source.server_enabled) throw new ServerMigrationError('SOURCE_SERVER_DISABLED', 'The source Jellyfin server is disabled.', 'preflight');
    if (String(source.server_id) === String(targetServerId)) throw new ServerMigrationError('SAME_SERVER', 'Source and target Jellyfin server must be different.', 'preflight');

    const target = await targetServerForPlan(entitlement, targetServerId);
    if (!target) throw new ServerMigrationError('TARGET_NOT_ELIGIBLE', 'Target server is not in this plan\'s eligible server pool.', 'preflight');
    if (!target.enabled) throw new ServerMigrationError('TARGET_DISABLED', 'Target Jellyfin server is disabled.', 'preflight');
    if (!target.allow_new_users) throw new ServerMigrationError('TARGET_CLOSED', 'Target server is closed to new users.', 'preflight');
    if (target.health_status === 'offline') throw new ServerMigrationError('TARGET_OFFLINE', 'Target Jellyfin server is offline.', 'preflight');
    if (target.server_class !== entitlement.server_class) throw new ServerMigrationError('TARGET_CLASS_MISMATCH', 'Target server class does not match the active plan.', 'preflight');
    if (isTrial(entitlement) && !target.trial_enabled) throw new ServerMigrationError('TARGET_TRIAL_DISABLED', 'Target server does not accept trial users.', 'preflight');
    if (!isTrial(entitlement) && !target.paid_enabled) throw new ServerMigrationError('TARGET_PAID_DISABLED', 'Target server does not accept paid users.', 'preflight');

    const assignedUsers = await activeAccountCount(target.id);
    if (Number(target.max_users || 0) > 0 && assignedUsers >= Number(target.max_users)) {
        throw new ServerMigrationError('TARGET_AT_CAPACITY', 'Target server has reached its configured user capacity.', 'preflight');
    }

    const duplicate = await query(`
        SELECT id,jellyfin_username,disabled FROM jellyfin_accounts
        WHERE customer_id=$1 AND server_id=$2
        LIMIT 1
    `, [customerId, target.id]);
    if (duplicate.rowCount) {
        throw new ServerMigrationError('TARGET_ACCOUNT_EXISTS', 'This customer already has a Jellyfin account recorded on the target server.', 'preflight');
    }

    if (!(await provisioning.usernameAvailable(target.id, source.jellyfin_username))) {
        throw new ServerMigrationError('TARGET_USERNAME_EXISTS', `Username ${source.jellyfin_username} already exists on the target Jellyfin server.`, 'preflight');
    }

    const effective = await provisioning.effectivePolicyForCustomer(customerId, entitlement);
    let libraryAccess;
    try {
        libraryAccess = await provisioning.resolveLibraryAccessForServer(target.id, effective.unrestricted, effective.visibleNames, false);
    } catch (error) {
        throw new ServerMigrationError('TARGET_LIBRARY_DISCOVERY_FAILED', `Could not read target server libraries: ${error.message}`, 'preflight');
    }
    if (libraryAccess.missing.length) {
        throw new ServerMigrationError(
            'TARGET_LIBRARIES_MISSING',
            `Target server is missing required libraries: ${libraryAccess.missing.join(', ')}`,
            'preflight'
        );
    }

    return {
        customerId,
        entitlement,
        source,
        target,
        effective,
        libraryAccess,
        capacity: {
            assignedUsers,
            maxUsers: Number(target.max_users || 0) || null,
            remaining: Number(target.max_users || 0) > 0 ? Math.max(0, Number(target.max_users) - assignedUsers) : null
        }
    };
}

async function createMigration(customerId, targetServerId, actorUserId) {
    const check = await preflight(customerId, targetServerId);
    try {
        const result = await query(`
            INSERT INTO customer_server_migrations(
                customer_id,source_account_id,source_server_id,target_server_id,
                status,detail,requested_by,requested_at,updated_at
            ) VALUES($1,$2,$3,$4,'pending',$5::jsonb,$6,NOW(),NOW())
            RETURNING *
        `, [
            customerId,
            check.source.id,
            check.source.server_id,
            check.target.id,
            JSON.stringify({
                planId: check.entitlement.plan_id,
                planCode: check.entitlement.code,
                username: check.source.jellyfin_username,
                effectiveStreams: check.effective.technical.streams,
                visibleLibraryCount: check.effective.visibleNames.length
            }),
            actorUserId || null
        ]);
        return result.rows[0];
    } catch (error) {
        if (error.code === '23505') throw new ServerMigrationError('MIGRATION_ALREADY_OPEN', 'This customer already has a pending or running server migration.');
        throw error;
    }
}

async function setMigrationRunning(migrationId) {
    return transaction(async client => {
        const locked = await client.query('SELECT * FROM customer_server_migrations WHERE id=$1 FOR UPDATE', [migrationId]);
        if (!locked.rowCount) throw new ServerMigrationError('MIGRATION_NOT_FOUND', 'Server migration not found.');
        const row = locked.rows[0];
        if (row.status !== 'pending') throw new ServerMigrationError('MIGRATION_NOT_PENDING', `Migration is already ${row.status}.`);
        const updated = await client.query(`
            UPDATE customer_server_migrations
            SET status='running',started_at=NOW(),failure_stage=NULL,last_error=NULL,updated_at=NOW()
            WHERE id=$1 RETURNING *
        `, [migrationId]);
        return updated.rows[0];
    });
}

async function markFailure(migrationId, stage, error, detail = {}) {
    await query(`
        UPDATE customer_server_migrations
        SET status='failed',failure_stage=$2,last_error=$3,
            detail=detail || $4::jsonb,completed_at=NOW(),updated_at=NOW()
        WHERE id=$1
    `, [migrationId, stage || null, String(error?.message || error || 'Migration failed').slice(0, 4000), JSON.stringify(detail)]);
}

async function markProvisioningStateDue(customerId, accountId, serverId) {
    await query(`
        INSERT INTO customer_provisioning_state(customer_id,status,jellyfin_account_id,server_id,next_attempt_at,updated_at)
        VALUES($1,'pending',$2,$3,NOW(),NOW())
        ON CONFLICT(customer_id) DO UPDATE SET
            status='pending',jellyfin_account_id=EXCLUDED.jellyfin_account_id,
            server_id=EXCLUDED.server_id,next_attempt_at=NOW(),updated_at=NOW()
    `, [customerId, accountId || null, serverId || null]);
}

async function executeMigration(migrationId) {
    const migration = await setMigrationRunning(migrationId);
    let targetAccount = null;
    let sourceDisabled = false;
    let stage = 'preflight';

    try {
        const check = await preflight(migration.customer_id, migration.target_server_id, {
            expectedSourceAccountId: migration.source_account_id
        });

        stage = 'create_target';
        targetAccount = await provisioning.createJellyfinAccount(
            migration.customer_id,
            check.target,
            check.effective,
            {
                preferredUsername: check.source.jellyfin_username,
                requireExactUsername: true,
                makePrimary: false
            }
        );
        await query(`
            UPDATE customer_server_migrations
            SET target_account_id=$2,detail=detail || $3::jsonb,updated_at=NOW()
            WHERE id=$1
        `, [migrationId, targetAccount.id, JSON.stringify({ targetJellyfinUserId: targetAccount.jellyfin_user_id })]);

        stage = 'disable_source';
        await provisioning.disableJellyfinAccount(check.source);
        sourceDisabled = true;

        stage = 'switch_primary';
        await provisioning.markPrimaryAccount(migration.customer_id, targetAccount.id);

        await query(`
            UPDATE customer_server_migrations
            SET status='succeeded',failure_stage=NULL,last_error=NULL,
                detail=detail || $2::jsonb,completed_at=NOW(),updated_at=NOW()
            WHERE id=$1
        `, [migrationId, JSON.stringify({
            sourceUsername: check.source.jellyfin_username,
            targetUsername: targetAccount.jellyfin_username,
            sourceDisabled: true,
            primaryAccountId: targetAccount.id
        })]);
        await query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.customer.server_migration.succeeded','customer',$2,$3::jsonb)
        `, [migration.requested_by || null, migration.customer_id, JSON.stringify({
            migrationId,
            sourceServerId: migration.source_server_id,
            targetServerId: migration.target_server_id,
            sourceAccountId: migration.source_account_id,
            targetAccountId: targetAccount.id
        })]);
        await markProvisioningStateDue(migration.customer_id, targetAccount.id, migration.target_server_id);
        return migrationForId(migrationId);
    } catch (error) {
        const cleanup = { sourceReenabled: false, targetDisabled: false };

        // If the source was disabled before a later step failed, restore it first.
        if (sourceDisabled) {
            try {
                const entitlement = await provisioning.currentEntitlement(migration.customer_id);
                const effective = entitlement ? await provisioning.effectivePolicyForCustomer(migration.customer_id, entitlement) : null;
                if (effective) {
                    const source = await query('SELECT * FROM jellyfin_accounts WHERE id=$1', [migration.source_account_id]);
                    if (source.rowCount) {
                        await provisioning.applyPolicy(source.rows[0], effective, false);
                        await provisioning.markPrimaryAccount(migration.customer_id, migration.source_account_id);
                        cleanup.sourceReenabled = true;
                    }
                }
            } catch (_) {}
        }

        // A target user created before cutover failure is retained for audit but
        // disabled so a failed migration cannot leave two usable accounts.
        if (targetAccount) {
            try {
                await provisioning.disableJellyfinAccount(targetAccount);
                cleanup.targetDisabled = true;
            } catch (_) {}
        }
        await markFailure(migrationId, stage, error, cleanup);
        await markProvisioningStateDue(migration.customer_id, migration.source_account_id, migration.source_server_id);
        throw error;
    }
}

async function rollbackMigration(migrationId, actorUserId) {
    const migration = await migrationForId(migrationId);
    if (!migration) throw new ServerMigrationError('MIGRATION_NOT_FOUND', 'Server migration not found.');
    if (migration.status !== 'succeeded') throw new ServerMigrationError('ROLLBACK_NOT_AVAILABLE', 'Only a successful migration can be rolled back.');
    if (!migration.target_account_id) throw new ServerMigrationError('ROLLBACK_TARGET_MISSING', 'Migration has no target account to roll back from.');

    const current = await primaryAccount(migration.customer_id);
    if (!current || String(current.id) !== String(migration.target_account_id)) {
        throw new ServerMigrationError('ROLLBACK_SUPERSEDED', 'The customer has moved again since this migration; this older migration cannot be rolled back safely.');
    }

    // Treat the old source as the rollback target and rerun the same plan safety
    // checks except for username collision (the source account already exists).
    const entitlement = await provisioning.currentEntitlement(migration.customer_id);
    if (!entitlement) throw new ServerMigrationError('ROLLBACK_NO_ENTITLEMENT', 'Customer has no active entitlement to restore.');
    const eligible = await targetServerForPlan(entitlement, migration.source_server_id);
    if (!eligible || !eligible.enabled || eligible.health_status === 'offline') {
        throw new ServerMigrationError('ROLLBACK_SOURCE_NOT_ELIGIBLE', 'Original source server is no longer eligible/available for this plan.');
    }

    const sourceResult = await query('SELECT * FROM jellyfin_accounts WHERE id=$1 AND customer_id=$2', [migration.source_account_id, migration.customer_id]);
    const targetResult = await query('SELECT * FROM jellyfin_accounts WHERE id=$1 AND customer_id=$2', [migration.target_account_id, migration.customer_id]);
    if (!sourceResult.rowCount || !targetResult.rowCount) throw new ServerMigrationError('ROLLBACK_ACCOUNT_MISSING', 'Source or target Jellyfin account is missing from CAPTaINFiN.');
    const source = sourceResult.rows[0];
    const target = targetResult.rows[0];
    const effective = await provisioning.effectivePolicyForCustomer(migration.customer_id, entitlement);
    const targetLibraries = await provisioning.resolveLibraryAccessForServer(source.server_id, effective.unrestricted, effective.visibleNames, false);
    if (targetLibraries.missing.length) {
        throw new ServerMigrationError('ROLLBACK_LIBRARIES_MISSING', `Original server is missing required libraries: ${targetLibraries.missing.join(', ')}`);
    }

    let sourceEnabled = false;
    try {
        await provisioning.applyPolicy(source, effective, false);
        sourceEnabled = true;
        await provisioning.disableJellyfinAccount(target);
        await provisioning.markPrimaryAccount(migration.customer_id, source.id);
        await query(`
            UPDATE customer_server_migrations
            SET status='rolled_back',failure_stage=NULL,last_error=NULL,
                rolled_back_at=NOW(),updated_at=NOW(),detail=detail || $2::jsonb
            WHERE id=$1
        `, [migrationId, JSON.stringify({ rollbackActorUserId: actorUserId || null })]);
        await query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.customer.server_migration.rolled_back','customer',$2,$3::jsonb)
        `, [actorUserId || null, migration.customer_id, JSON.stringify({ migrationId })]);
        await markProvisioningStateDue(migration.customer_id, source.id, source.server_id);
        return migrationForId(migrationId);
    } catch (error) {
        if (sourceEnabled) {
            try { await provisioning.disableJellyfinAccount(source); } catch (_) {}
        }
        await query(`
            UPDATE customer_server_migrations
            SET status='rollback_failed',failure_stage='rollback',last_error=$2,updated_at=NOW()
            WHERE id=$1
        `, [migrationId, String(error.message || error).slice(0, 4000)]);
        throw error;
    }
}

async function listMigrations(limit = 100) {
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    const result = await query(`
        SELECT m.*,
               COALESCE(NULLIF(c.display_name,''),u.username,c.email,'Customer') AS customer_name,
               src.name AS source_server_name,src.slug AS source_server_slug,
               dst.name AS target_server_name,dst.slug AS target_server_slug,
               sa.jellyfin_username AS source_username,
               ta.jellyfin_username AS target_username
        FROM customer_server_migrations m
        JOIN customers c ON c.id=m.customer_id
        LEFT JOIN app_users u ON u.id=c.user_id
        JOIN jellyfin_servers src ON src.id=m.source_server_id
        JOIN jellyfin_servers dst ON dst.id=m.target_server_id
        JOIN jellyfin_accounts sa ON sa.id=m.source_account_id
        LEFT JOIN jellyfin_accounts ta ON ta.id=m.target_account_id
        ORDER BY m.requested_at DESC
        LIMIT $1
    `, [n]);
    return result.rows;
}

async function migrationCandidates(limit = 500) {
    const n = Math.max(1, Math.min(1000, Number(limit) || 500));
    const result = await query(`
        WITH active AS (
            SELECT DISTINCT ON (s.customer_id)
                   s.customer_id,p.id AS plan_id,p.code AS plan_code,p.name AS plan_name,p.server_class,
                   p.billing_interval,p.current_period_end
            FROM subscriptions s
            JOIN plans p ON p.id=s.plan_id
            WHERE s.status IN ('active','trialing','past_due')
              AND s.current_period_end>NOW() AND p.active=TRUE
            ORDER BY s.customer_id,s.current_period_end DESC,s.created_at DESC
        )
        SELECT c.id AS customer_id,
               COALESCE(NULLIF(c.display_name,''),u.username,c.email,'Customer') AS customer_name,
               a.plan_id,a.plan_code,a.plan_name,a.server_class,a.billing_interval,
               ja.id AS source_account_id,ja.jellyfin_username,
               js.id AS source_server_id,js.name AS source_server_name,js.slug AS source_server_slug
        FROM active a
        JOIN customers c ON c.id=a.customer_id
        LEFT JOIN app_users u ON u.id=c.user_id
        JOIN LATERAL (
            SELECT account.* FROM jellyfin_accounts account
            WHERE account.customer_id=c.id
            ORDER BY account.is_primary DESC,account.disabled ASC,account.updated_at DESC
            LIMIT 1
        ) ja ON TRUE
        JOIN jellyfin_servers js ON js.id=ja.server_id
        WHERE NOT EXISTS (
            SELECT 1 FROM customer_server_migrations m
            WHERE m.customer_id=c.id AND m.status IN ('pending','running')
        )
        ORDER BY customer_name
        LIMIT $1
    `, [n]);
    return result.rows;
}

async function enabledServers() {
    const result = await query(`
        SELECT id,name,slug,server_class,health_status,allow_new_users,max_users,trial_enabled,paid_enabled
        FROM jellyfin_servers
        WHERE enabled=TRUE
        ORDER BY server_class,priority,name
    `);
    return result.rows;
}

module.exports = {
    OPEN_STATUSES,
    FINAL_STATUSES,
    ServerMigrationError,
    primaryAccount,
    preflight,
    createMigration,
    executeMigration,
    rollbackMigration,
    listMigrations,
    migrationForId,
    migrationCandidates,
    enabledServers
};
