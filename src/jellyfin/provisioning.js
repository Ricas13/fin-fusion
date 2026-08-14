'use strict';

const crypto = require('crypto');
const { query, transaction } = require('../db');
const registry = require('./registry');
const policy = require('./policy');
const placement = require('./placement');
const planServers = require('./plan-servers');

function randomPassword() {
    return crypto.randomBytes(24).toString('base64url');
}

// ---- Library discovery -----------------------------------------------

async function discoverServerLibraries(serverId) {
    const folders = await registry.request(serverId, '/Library/VirtualFolders', { timeoutMs: 7000 });
    if (!Array.isArray(folders)) throw new Error('Jellyfin did not return a valid library list');
    return folders
        .filter(folder => folder && folder.ItemId && folder.Name)
        .map(folder => ({ id: String(folder.ItemId), name: String(folder.Name).trim() }));
}

async function libraryCatalogFromServers(servers) {
    const names = new Set();
    const failedServers = [];
    for (const server of servers) {
        try {
            (await discoverServerLibraries(server.id)).forEach(folder => names.add(folder.name));
        } catch (error) {
            failedServers.push(server.name);
        }
    }
    return {
        names: Array.from(names).sort((a, b) => a.localeCompare(b)),
        failedServers,
        serverCount: servers.length
    };
}

// Compatibility helper for callers that only have a class rather than a plan.
async function libraryCatalogForServerClass(serverClass) {
    const result = await query(`
        SELECT id,name FROM jellyfin_servers
        WHERE enabled=TRUE AND server_class=$1 ORDER BY priority,name
    `, [serverClass]);
    return libraryCatalogFromServers(result.rows);
}

// Plan-aware catalogue. When a plan has an explicit placement pool, policy
// choices and reconciliation must use that same pool rather than libraries
// from unrelated servers of the same class.
async function libraryCatalogForPlan(plan) {
    if (!plan) return { names: [], failedServers: [], serverCount: 0 };
    const servers = await planServers.eligibleServersForPlan(plan, { enabledOnly: true });
    return libraryCatalogFromServers(servers);
}

// ---- Per-customer overrides (admin) -----------------------------------

async function getPolicyOverride(customerId) {
    const result = await query('SELECT * FROM customer_policy_overrides WHERE customer_id=$1', [customerId]);
    return result.rows[0] || null;
}

async function setPolicyOverrideField(customerId, field, value, actorUserId) {
    if (!policy.TECHNICAL_FIELDS.includes(field)) throw new Error('Unknown policy field');
    if (field === 'streams') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error('Streams override must be between 1 and 50');
        value = n;
    } else {
        value = Boolean(value);
    }
    await query(`
        INSERT INTO customer_policy_overrides(customer_id,${field},updated_by,updated_at)
        VALUES($1,$2,$3,NOW())
        ON CONFLICT (customer_id) DO UPDATE SET ${field}=EXCLUDED.${field},updated_by=EXCLUDED.updated_by,updated_at=NOW()
    `, [customerId, value, actorUserId || null]);
}

async function resetPolicyOverrideField(customerId, field, actorUserId) {
    if (!policy.TECHNICAL_FIELDS.includes(field)) throw new Error('Unknown policy field');
    await query(`
        INSERT INTO customer_policy_overrides(customer_id,updated_by,updated_at) VALUES($1,$2,NOW())
        ON CONFLICT (customer_id) DO UPDATE SET ${field}=NULL,updated_by=EXCLUDED.updated_by,updated_at=NOW()
    `, [customerId, actorUserId || null]);
}

async function resetAllPolicyOverrides(customerId, actorUserId) {
    const sets = policy.TECHNICAL_FIELDS.map(field => `${field}=NULL`).join(',');
    await query(`
        INSERT INTO customer_policy_overrides(customer_id,updated_by,updated_at) VALUES($1,$2,NOW())
        ON CONFLICT (customer_id) DO UPDATE SET ${sets},updated_by=EXCLUDED.updated_by,updated_at=NOW()
    `, [customerId, actorUserId || null]);
}

async function getLibraryOverrides(customerId) {
    const result = await query('SELECT library_name,granted FROM customer_library_overrides WHERE customer_id=$1', [customerId]);
    return result.rows;
}

async function setLibraryOverride(customerId, libraryName, granted, actorUserId) {
    const name = String(libraryName || '').trim().slice(0, 200);
    if (!name) throw new Error('Library name is required');
    await query(`
        INSERT INTO customer_library_overrides(customer_id,library_name,granted,updated_by,updated_at)
        VALUES($1,$2,$3,$4,NOW())
        ON CONFLICT (customer_id,library_name) DO UPDATE SET granted=EXCLUDED.granted,updated_by=EXCLUDED.updated_by,updated_at=NOW()
    `, [customerId, name, Boolean(granted), actorUserId || null]);
}

async function resetLibraryOverride(customerId, libraryName) {
    await query('DELETE FROM customer_library_overrides WHERE customer_id=$1 AND library_name=$2', [
        customerId, String(libraryName || '').trim().slice(0, 200)
    ]);
}

async function resetAllLibraryOverrides(customerId) {
    await query('DELETE FROM customer_library_overrides WHERE customer_id=$1', [customerId]);
}

// ---- Customer's own library deselection (self-service) ----------------

async function getLibrarySelection(customerId) {
    const result = await query('SELECT selected_names FROM customer_library_selection WHERE customer_id=$1', [customerId]);
    return result.rows[0] || null;
}

// Persisting a name never grants access on its own; every apply path intersects
// it with the server-computed plan entitlement.
async function setLibrarySelection(customerId, names) {
    const clean = policy.normalizedNames(names).slice(0, 500).map(n => n.slice(0, 200));
    await query(`
        INSERT INTO customer_library_selection(customer_id,selected_names,updated_at)
        VALUES($1,$2::text[],NOW())
        ON CONFLICT (customer_id) DO UPDATE SET selected_names=EXCLUDED.selected_names,updated_at=NOW()
    `, [customerId, clean]);
}

// ---- Effective policy computation --------------------------------------

async function effectivePolicyForCustomer(customerId, plan) {
    const [override, libOverrides, selection] = await Promise.all([
        getPolicyOverride(customerId),
        getLibraryOverrides(customerId),
        getLibrarySelection(customerId)
    ]);
    const technicalRows = policy.effectiveTechnicalPolicy(plan, override);
    const catalog = plan
        ? await libraryCatalogForPlan(plan)
        : { names: [], failedServers: [], serverCount: 0 };
    const entitlementRows = policy.libraryEntitlement(plan, libOverrides, catalog.names);
    const visibleNames = policy.customerVisibleLibraries(entitlementRows, selection);
    const mode = ['all', 'exclude', 'include'].includes(plan?.library_access_mode) ? plan.library_access_mode : 'all';
    const unrestricted = mode === 'all' && libOverrides.length === 0 && !selection;
    return {
        override,
        libOverrides,
        selection,
        technicalRows,
        technical: policy.flattenEffective(technicalRows),
        catalog,
        entitlementRows,
        visibleNames,
        unrestricted
    };
}

// ---- Reconciliation status tracking ------------------------------------

async function upsertReconciliationStatus(accountId, customerId, status, errorMessage = null) {
    await query(`
        INSERT INTO jellyfin_policy_reconciliation(jellyfin_account_id,customer_id,status,attempt_count,last_error,last_attempt_at,updated_at)
        VALUES($1,$2,$3,1,$4,NOW(),NOW())
        ON CONFLICT (jellyfin_account_id) DO UPDATE SET
            customer_id=EXCLUDED.customer_id,
            status=EXCLUDED.status,
            attempt_count=jellyfin_policy_reconciliation.attempt_count+1,
            last_error=EXCLUDED.last_error,
            last_attempt_at=NOW(),
            updated_at=NOW()
    `, [accountId, customerId, status, errorMessage]);
}

async function markReconciliationRunning(accountId, customerId) {
    await query(`
        INSERT INTO jellyfin_policy_reconciliation(jellyfin_account_id,customer_id,status,requested_at,updated_at)
        VALUES($1,$2,'running',NOW(),NOW())
        ON CONFLICT (jellyfin_account_id) DO UPDATE SET status='running',customer_id=EXCLUDED.customer_id,updated_at=NOW()
    `, [accountId, customerId]);
}

// ---- Policy body + library resolution ----------------------------------

function policyBody(effectiveTechnical, disabled, libraryAccess) {
    const enabled = !disabled;
    return {
        IsAdministrator: false,
        IsHidden: true,
        IsDisabled: disabled,
        EnableAllDevices: enabled,
        EnableAllFolders: enabled && Boolean(libraryAccess.enableAllFolders),
        EnabledFolders: enabled ? (Array.isArray(libraryAccess.enabledFolders) ? libraryAccess.enabledFolders : []) : [],
        EnableAllChannels: false,
        EnableRemoteAccess: enabled && Boolean(effectiveTechnical.allow_remote_access),
        EnableMediaPlayback: enabled,
        EnableAudioPlaybackTranscoding: enabled && Boolean(effectiveTechnical.allow_audio_transcoding),
        EnableVideoPlaybackTranscoding: enabled && Boolean(effectiveTechnical.allow_video_transcoding),
        EnablePlaybackRemuxing: enabled && Boolean(effectiveTechnical.allow_remuxing),
        EnableContentDownloading: enabled && Boolean(effectiveTechnical.allow_downloads),
        EnableSyncTranscoding: false,
        EnableMediaConversion: false,
        EnableContentDeletion: false,
        EnableRemoteControlOfOtherUsers: false,
        EnableSharedDeviceControl: false,
        EnableLiveTvManagement: enabled && Boolean(effectiveTechnical.allow_live_tv_management),
        EnableLiveTvAccess: enabled && Boolean(effectiveTechnical.allow_live_tv),
        EnableUserPreferenceAccess: enabled,
        AuthenticationProviderId: 'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider',
        PasswordResetProviderId: 'Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider',
        SyncPlayAccess: 'None'
    };
}

async function resolveLibraryAccessForServer(serverId, unrestricted, visibleNames, disabled) {
    if (disabled) return { enableAllFolders: false, enabledFolders: [], missing: [] };
    if (unrestricted) return { enableAllFolders: true, enabledFolders: [], missing: [] };
    const folders = await discoverServerLibraries(serverId);
    const { enabledFolders, missing } = policy.resolveNamesToIds(visibleNames, folders);
    return { enableAllFolders: false, enabledFolders, missing };
}

async function selectServerForPlan(plan) {
    const isTrial = plan.billing_interval === 'trial';
    const planId = planServers.planId(plan);
    if (!planId) throw new Error('Plan id is required for server placement');

    const result = await query(`
        WITH restriction AS (
            SELECT EXISTS(
                SELECT 1
                FROM plan_server_eligibility pse
                JOIN jellyfin_servers restricted_server ON restricted_server.id=pse.server_id
                WHERE pse.plan_id=$3 AND restricted_server.server_class=$1
            ) AS restricted
        )
        SELECT js.*,
               COUNT(DISTINCT ja.id)::int AS assigned_users,
               COUNT(DISTINCT aps.jellyfin_session_id)::int AS active_streams,
               COALESCE(pse.weight,100)::int AS placement_weight
        FROM jellyfin_servers js
        CROSS JOIN restriction r
        LEFT JOIN plan_server_eligibility pse
               ON pse.plan_id=$3 AND pse.server_id=js.id
        LEFT JOIN jellyfin_accounts ja
               ON ja.server_id=js.id AND ja.disabled=FALSE
        LEFT JOIN active_playback_sessions aps
               ON aps.server_id=js.id
        WHERE js.enabled=TRUE
          AND js.allow_new_users=TRUE
          AND js.server_class=$1
          AND js.health_status <> 'offline'
          AND CASE WHEN $2::boolean THEN js.trial_enabled ELSE js.paid_enabled END
          AND (NOT r.restricted OR pse.server_id IS NOT NULL)
        GROUP BY js.id,pse.weight,r.restricted
        HAVING js.max_users IS NULL OR js.max_users=0 OR COUNT(DISTINCT ja.id) < js.max_users
    `, [plan.server_class, isTrial, planId]);

    return placement.selectServer(result.rows, plan.placement_strategy);
}

async function currentEntitlement(customerId) {
    const result = await query(`
        SELECT s.*,p.*,
               s.id AS subscription_id,p.id AS plan_id
        FROM subscriptions s
        JOIN plans p ON p.id=s.plan_id
        JOIN customers c ON c.id=s.customer_id
        WHERE s.customer_id=$1
          AND c.access_paused_at IS NULL
          AND s.status IN ('active','trialing','past_due')
          AND s.current_period_end > NOW()
          AND p.active=TRUE
        ORDER BY s.current_period_end DESC,s.created_at DESC
        LIMIT 1
    `, [customerId]);
    return result.rows[0] || null;
}

async function preferredUsername(customerId) {
    const result = await query(`
        SELECT COALESCE(NULLIF(c.display_name,''),u.username,'user') AS username
        FROM customers c LEFT JOIN app_users u ON u.id=c.user_id
        WHERE c.id=$1
    `, [customerId]);
    if (!result.rowCount) throw new Error('Customer not found');
    return String(result.rows[0].username || 'user').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'user';
}

async function uniqueUsername(serverId, preferred) {
    const users = await registry.request(serverId, '/Users');
    const names = new Set((Array.isArray(users) ? users : []).map(u => String(u.Name || '').toLowerCase()));
    if (!names.has(preferred.toLowerCase())) return preferred;
    for (let i = 0; i < 20; i++) {
        const suffix = crypto.randomInt(1000, 10000);
        const candidate = `${preferred.slice(0, 35)}${suffix}`;
        if (!names.has(candidate.toLowerCase())) return candidate;
    }
    throw new Error('Unable to generate a unique Jellyfin username');
}

async function createJellyfinAccount(customerId, server, effective) {
    const preferred = await preferredUsername(customerId);
    const username = await uniqueUsername(server.id, preferred);
    const bootstrapPassword = randomPassword();
    const libraryAccess = await resolveLibraryAccessForServer(server.id, effective.unrestricted, effective.visibleNames, false);
    const created = await registry.request(server.id, '/Users/New', {
        method: 'POST',
        body: { Name: username, Password: bootstrapPassword }
    });
    if (!created || !created.Id) throw new Error('Jellyfin did not return a user ID');

    try {
        await registry.request(server.id, `/Users/${created.Id}/Policy`, {
            method: 'POST',
            body: policyBody(effective.technical, false, libraryAccess)
        });
    } catch (error) {
        try { await registry.request(server.id, `/Users/${created.Id}`, { method: 'DELETE' }); } catch (_) {}
        throw error;
    }

    const stored = await query(`
        INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,last_policy_sync)
        VALUES($1,$2,$3,$4,FALSE,NOW())
        RETURNING *
    `, [customerId, server.id, created.Id, username]);
    const account = stored.rows[0];
    if (libraryAccess.missing.length) {
        const message = `Missing on server: ${libraryAccess.missing.join(', ')}`;
        await upsertReconciliationStatus(account.id, customerId, 'failed', message);
        throw new Error(`Jellyfin account created with a narrowed library set -- ${message}`);
    }
    await upsertReconciliationStatus(account.id, customerId, 'successful', null);
    return account;
}

async function applyPolicy(account, effective, disabled = false) {
    await markReconciliationRunning(account.id, account.customer_id);
    let libraryAccess;
    try {
        libraryAccess = await resolveLibraryAccessForServer(account.server_id, effective.unrestricted, effective.visibleNames, disabled);
    } catch (error) {
        await upsertReconciliationStatus(account.id, account.customer_id, 'failed', `Library discovery failed: ${error.message}`);
        throw error;
    }
    try {
        await registry.request(account.server_id, `/Users/${account.jellyfin_user_id}/Policy`, {
            method: 'POST',
            body: policyBody(effective.technical, disabled, libraryAccess)
        });
    } catch (error) {
        await upsertReconciliationStatus(account.id, account.customer_id, 'failed', error.message);
        throw error;
    }
    await query(`
        UPDATE jellyfin_accounts
        SET disabled=$1,last_policy_sync=NOW(),updated_at=NOW()
        WHERE id=$2
    `, [disabled, account.id]);
    if (libraryAccess.missing.length) {
        const message = `Missing on server: ${libraryAccess.missing.join(', ')}`;
        await upsertReconciliationStatus(account.id, account.customer_id, 'failed', message);
        throw new Error(`Jellyfin policy applied with a narrowed library set -- ${message}`);
    }
    await upsertReconciliationStatus(account.id, account.customer_id, 'successful', null);
    return { missing: [] };
}

const DISABLED_EFFECTIVE = {
    technical: policy.flattenEffective(policy.effectiveTechnicalPolicy(null, null)),
    unrestricted: false,
    visibleNames: []
};

async function recordRun(customerId, subscriptionId, action, fn) {
    const started = await query(`
        INSERT INTO provisioning_runs(customer_id,subscription_id,action,status)
        VALUES($1,$2,$3,'started') RETURNING id
    `, [customerId, subscriptionId || null, action]);
    const id = started.rows[0].id;
    try {
        const value = await fn();
        await query(`UPDATE provisioning_runs SET status='succeeded',completed_at=NOW() WHERE id=$1`, [id]);
        return value;
    } catch (error) {
        await query(`
            UPDATE provisioning_runs
            SET status='failed',detail=$2::jsonb,completed_at=NOW()
            WHERE id=$1
        `, [id, JSON.stringify({ error: error.message })]);
        throw error;
    }
}

async function reconcileCustomer(customerId) {
    const entitlement = await currentEntitlement(customerId);
    return recordRun(customerId, entitlement?.subscription_id || null, entitlement ? 'reconcile' : 'disable', async () => {
        const accountsResult = await query(`
            SELECT ja.*,js.enabled AS server_enabled,js.server_class
            FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id
            WHERE ja.customer_id=$1 ORDER BY ja.created_at ASC
        `, [customerId]);
        const accounts = accountsResult.rows;

        if (!entitlement) {
            for (const account of accounts) {
                if (!account.disabled && account.server_enabled) {
                    await applyPolicy(account, DISABLED_EFFECTIVE, true);
                }
            }
            return { active: false, disabled: accounts.length };
        }

        const effective = await effectivePolicyForCustomer(customerId, entitlement);

        // Placement is intentionally only for accounts that still need to be
        // created. Existing matching accounts stay put until a deliberate
        // migration workflow is introduced.
        let account = accounts.find(a => a.server_class === entitlement.server_class && a.server_enabled);
        if (!account) {
            const server = await selectServerForPlan(entitlement);
            if (!server) throw new Error(`No eligible Jellyfin server is currently available for plan ${entitlement.code}`);
            account = await createJellyfinAccount(customerId, server, effective);
        } else {
            await applyPolicy(account, effective, false);
        }
        for (const old of accounts) {
            if (old.id !== account.id && !old.disabled && old.server_enabled) {
                await applyPolicy(old, DISABLED_EFFECTIVE, true);
            }
        }

        await query(`
            INSERT INTO audit_log(action,entity_type,entity_id,metadata)
            VALUES('entitlement.reconcile','customer',$1,$2::jsonb)
        `, [customerId, JSON.stringify({
            subscriptionId: entitlement.subscription_id,
            planCode: entitlement.code,
            serverId: account.server_id,
            jellyfinAccountId: account.id,
            effectiveStreams: effective.technical.streams,
            libraryVisibleCount: effective.visibleNames.length,
            placementStrategy: placement.normalizeStrategy(entitlement.placement_strategy)
        })]);

        return { active: true, entitlement, account, effective };
    });
}

async function reconcileAccount(accountId) {
    const result = await query(`
        SELECT ja.*,js.enabled AS server_enabled FROM jellyfin_accounts ja
        JOIN jellyfin_servers js ON js.id=ja.server_id WHERE ja.id=$1
    `, [accountId]);
    if (!result.rowCount) throw new Error('Jellyfin account not found');
    const account = result.rows[0];
    const entitlement = await currentEntitlement(account.customer_id);
    if (!entitlement || !account.server_enabled) {
        return applyPolicy(account, DISABLED_EFFECTIVE, true);
    }
    const effective = await effectivePolicyForCustomer(account.customer_id, entitlement);
    return applyPolicy(account, effective, false);
}

async function setJellyfinPassword(customerId, accountId, newPassword) {
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 200) {
        throw new Error('Jellyfin password must be between 8 and 200 characters');
    }
    const result = await query(`
        SELECT * FROM jellyfin_accounts WHERE id=$1 AND customer_id=$2
    `, [accountId, customerId]);
    if (!result.rowCount) throw new Error('Jellyfin account not found');
    const account = result.rows[0];

    return recordRun(customerId, null, 'password_reset', async () => {
        await registry.request(account.server_id, `/Users/${account.jellyfin_user_id}/Password`, {
            method: 'POST',
            body: { Id: account.jellyfin_user_id, NewPw: newPassword }
        });
        return true;
    });
}

async function holdAccess(customerId, reason) {
    await query(`UPDATE customers SET access_paused_at=NOW(),access_hold_reason=$2 WHERE id=$1`, [customerId, reason]);
    return reconcileCustomer(customerId);
}

async function releaseAccess(customerId) {
    await query(`UPDATE customers SET access_paused_at=NULL,access_hold_reason=NULL WHERE id=$1`, [customerId]);
    return reconcileCustomer(customerId);
}

async function expireSubscriptionsAndReconcile() {
    const expired = await transaction(async client => {
        const rows = await client.query(`
            WITH expired AS (
                UPDATE subscriptions
                SET status='expired',updated_at=NOW()
                WHERE status IN ('active','trialing','past_due') AND current_period_end <= NOW()
                RETURNING customer_id
            )
            SELECT DISTINCT customer_id FROM expired
        `);
        return rows.rows.map(r => r.customer_id);
    });
    for (const customerId of expired) {
        try { await reconcileCustomer(customerId); } catch (error) {
            console.error(`Entitlement reconcile failed for ${customerId}:`, error.message);
        }
    }
    return expired.length;
}

module.exports = {
    discoverServerLibraries,
    libraryCatalogForServerClass,
    libraryCatalogForPlan,
    upsertReconciliationStatus,
    getPolicyOverride,
    setPolicyOverrideField,
    resetPolicyOverrideField,
    resetAllPolicyOverrides,
    getLibraryOverrides,
    setLibraryOverride,
    resetLibraryOverride,
    resetAllLibraryOverrides,
    getLibrarySelection,
    setLibrarySelection,
    effectivePolicyForCustomer,
    selectServerForPlan,
    currentEntitlement,
    reconcileCustomer,
    reconcileAccount,
    holdAccess,
    releaseAccess,
    setJellyfinPassword,
    expireSubscriptionsAndReconcile
};
