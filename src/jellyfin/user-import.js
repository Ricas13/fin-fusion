'use strict';

const { query, transaction } = require('../db');
const planExpiry = require('../entitlements/plan-expiry');
const registry = require('./registry');
const planServers = require('./plan-servers');
const provisioning = require('./provisioning');

function asId(value) {
    const id = String(value || '').trim();
    if (!id || id.length > 128) throw new Error('A valid Jellyfin user ID is required.');
    return id;
}

function cleanName(value) {
    const name = String(value || '').trim().slice(0, 120);
    if (!name) throw new Error('Jellyfin user has no usable name.');
    return name;
}

function safeDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function remoteShape(server, user) {
    const policy = user?.Policy || {};
    return {
        server_id: server.id,
        server_name: server.name,
        server_slug: server.slug,
        server_class: server.server_class,
        jellyfin_user_id: String(user?.Id || ''),
        jellyfin_username: String(user?.Name || '').trim(),
        disabled: Boolean(policy.IsDisabled),
        administrator: Boolean(policy.IsAdministrator),
        hidden: Boolean(policy.IsHidden),
        has_password: Boolean(user?.HasPassword),
        last_login_at: safeDate(user?.LastLoginDate),
        last_activity_at: safeDate(user?.LastActivityDate)
    };
}

function assertImportableIdentity(user) {
    if (user?.disabled) {
        throw new Error('Disabled Jellyfin users cannot be managed by CAPTAiNFiN. Enable the Jellyfin user before importing/linking it, or delete it if it should not have access.');
    }
}

async function serversForDiscovery(serverId = null) {
    const servers = await registry.listServers({ enabledOnly: true });
    if (!serverId) return servers;
    const filtered = servers.filter(server => String(server.id) === String(serverId));
    if (!filtered.length) throw new Error('Selected Jellyfin server is unavailable or disabled.');
    return filtered;
}

async function remoteUsers(server) {
    const users = await registry.request(server.id, '/Users', { timeoutMs: 10000 });
    if (!Array.isArray(users)) throw new Error(`${server.name} did not return a valid Jellyfin user list.`);
    return users.filter(user => user?.Id && user?.Name).map(user => remoteShape(server, user));
}

async function managedAccounts() {
    const result = await query(`
        SELECT ja.id AS jellyfin_account_id,ja.server_id,ja.jellyfin_user_id,ja.jellyfin_username,
               ja.disabled AS managed_disabled,ja.is_primary,ja.customer_id,
               COALESCE(NULLIF(c.display_name,''),NULLIF(au.username,''),ja.jellyfin_username) AS customer_name,
               au.username AS portal_username,au.email AS portal_email,
               sub.plan_name,sub.plan_code,sub.subscription_status,sub.current_period_end
        FROM jellyfin_accounts ja
        JOIN customers c ON c.id=ja.customer_id
        LEFT JOIN app_users au ON au.id=c.user_id
        LEFT JOIN LATERAL (
            SELECT p.name AS plan_name,p.code AS plan_code,s.status AS subscription_status,s.current_period_end
            FROM subscriptions s JOIN plans p ON p.id=s.plan_id
            WHERE s.customer_id=c.id
            ORDER BY (s.status IN ('active','trialing','past_due') AND s.current_period_end>NOW()) DESC,
                     s.current_period_end DESC,s.created_at DESC
            LIMIT 1
        ) sub ON TRUE
    `);
    return result.rows;
}

function classify(remote, exactMap, nameMap) {
    const exact = exactMap.get(`${remote.server_id}:${remote.jellyfin_user_id}`);
    if (exact) return { ...remote, import_status: 'managed', managed: exact };
    const name = nameMap.get(`${remote.server_id}:${remote.jellyfin_username.toLowerCase()}`);
    if (name) return { ...remote, import_status: 'identity_drift', managed: name };
    if (remote.administrator) return { ...remote, import_status: 'administrator', managed: null };
    return { ...remote, import_status: 'unmanaged', managed: null };
}

async function discover({ serverId = null } = {}) {
    const [servers, accounts] = await Promise.all([serversForDiscovery(serverId), managedAccounts()]);
    const exactMap = new Map(accounts.map(account => [`${account.server_id}:${account.jellyfin_user_id}`, account]));
    const nameMap = new Map(accounts.map(account => [`${account.server_id}:${String(account.jellyfin_username).toLowerCase()}`, account]));
    const rows = [];
    const failures = [];
    for (const server of servers) {
        try {
            const users = await remoteUsers(server);
            rows.push(...users.map(user => classify(user, exactMap, nameMap)));
        } catch (error) {
            failures.push({ serverId: server.id, serverName: server.name, error: error.message });
        }
    }
    rows.sort((a, b) => a.server_name.localeCompare(b.server_name) || a.jellyfin_username.localeCompare(b.jellyfin_username));
    return { servers, rows, failures };
}

async function getRemoteUser(serverId, jellyfinUserId) {
    const servers = await serversForDiscovery(serverId);
    const server = servers[0];
    const id = asId(jellyfinUserId);
    const users = await remoteUsers(server);
    const user = users.find(candidate => candidate.jellyfin_user_id === id);
    if (!user) throw new Error('Jellyfin user no longer exists on that server. Refresh discovery and try again.');
    return { server, user };
}

async function loadPlan(planId) {
    if (!planId) return null;
    const result = await query('SELECT * FROM plans WHERE id=$1 AND active=TRUE', [planId]);
    if (!result.rowCount) throw new Error('Selected plan is unavailable or archived.');
    return result.rows[0];
}

async function assertServerFitsPlan(server, plan) {
    if (!plan) return true;
    if (String(server.server_class) !== String(plan.server_class)) {
        throw new Error(`Plan ${plan.name} requires ${plan.server_class} servers; ${server.name} is ${server.server_class}.`);
    }
    const eligible = await planServers.eligibleServersForPlan(plan, { enabledOnly: true });
    if (!eligible.some(candidate => String(candidate.id) === String(server.id))) {
        throw new Error(`${server.name} is not in the eligible server pool for plan ${plan.name}.`);
    }
    if (plan.billing_interval === 'trial' && server.trial_enabled === false) {
        throw new Error(`${server.name} does not accept trial users.`);
    }
    if (plan.billing_interval !== 'trial' && !planExpiry.isFreeTier(plan) && server.paid_enabled === false) {
        throw new Error(`${server.name} does not accept paid users.`);
    }
    return true;
}

function expiryForPlan(plan, override) {
    if (!plan) return null;
    return planExpiry.endForPlan(plan, { override });
}

async function assertRemoteUnmanaged(client, serverId, user) {
    const existing = await client.query(`
        SELECT ja.id,ja.customer_id,ja.jellyfin_user_id,ja.jellyfin_username
        FROM jellyfin_accounts ja
        WHERE ja.server_id=$1 AND (ja.jellyfin_user_id=$2 OR lower(ja.jellyfin_username)=lower($3))
        LIMIT 1 FOR UPDATE
    `, [serverId, user.jellyfin_user_id, user.jellyfin_username]);
    if (!existing.rowCount) return;
    const row = existing.rows[0];
    if (row.jellyfin_user_id === user.jellyfin_user_id) throw new Error(`${user.jellyfin_username} is already managed by CAPTAiNFiN.`);
    throw new Error(`${user.jellyfin_username} matches a managed account whose Jellyfin ID changed. Use Rebind ID instead of importing a duplicate.`);
}

async function createImportedCustomer({ serverId, jellyfinUserId, planId = null, expiresAt = null, applyPolicy = false, actorUserId = null }) {
    const [{ server, user }, plan] = await Promise.all([getRemoteUser(serverId, jellyfinUserId), loadPlan(planId)]);
    if (user.administrator) throw new Error('Jellyfin administrator accounts cannot be imported as customers.');
    assertImportableIdentity(user);
    await assertServerFitsPlan(server, plan);
    const periodEnd = expiryForPlan(plan, expiresAt);
    const created = await transaction(async client => {
        await assertRemoteUnmanaged(client, server.id, user);
        const customer = await client.query(`
            INSERT INTO customers(display_name,email,note)
            VALUES($1,NULL,'Imported from existing Jellyfin account')
            RETURNING *
        `, [cleanName(user.jellyfin_username)]);
        const customerId = customer.rows[0].id;
        const account = await client.query(`
            INSERT INTO jellyfin_accounts(
                customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,last_activity_at,last_policy_sync,is_primary
            ) VALUES($1,$2,$3,$4,FALSE,$5,NULL,TRUE)
            RETURNING *
        `, [customerId, server.id, user.jellyfin_user_id, cleanName(user.jellyfin_username), user.last_activity_at]);
        let subscription = null;
        if (plan) {
            const status = plan.billing_interval === 'trial' ? 'trialing' : 'active';
            const inserted = await client.query(`
                INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
                VALUES($1,$2,$3,'migration',NOW(),$4)
                RETURNING *
            `, [customerId, plan.id, status, periodEnd]);
            subscription = inserted.rows[0];
        }
        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'jellyfin.import.customer','customer',$2,$3::jsonb)
        `, [actorUserId || null, customerId, JSON.stringify({
            serverId: server.id,
            serverName: server.name,
            jellyfinUserId: user.jellyfin_user_id,
            jellyfinUsername: user.jellyfin_username,
            planId: plan?.id || null,
            planCode: plan?.code || null,
            freeTier: Boolean(plan?.is_free_tier),
            applyPolicy: Boolean(applyPolicy)
        })]);
        return { customer: customer.rows[0], account: account.rows[0], subscription };
    });

    if (applyPolicy && plan) await provisioning.reconcileCustomer(created.customer.id);
    return { ...created, server, user, plan };
}

async function customerSummary(customerId) {
    const result = await query(`
        SELECT c.id,c.display_name,c.email,au.username AS portal_username,
               active.plan_id,active.plan_name,active.plan_code,active.server_class AS plan_server_class
        FROM customers c
        LEFT JOIN app_users au ON au.id=c.user_id
        LEFT JOIN LATERAL (
            SELECT p.id AS plan_id,p.name AS plan_name,p.code AS plan_code,p.server_class
            FROM subscriptions s JOIN plans p ON p.id=s.plan_id
            WHERE s.customer_id=c.id AND s.status IN ('active','trialing','past_due') AND s.current_period_end>NOW() AND p.active=TRUE
            ORDER BY s.current_period_end DESC LIMIT 1
        ) active ON TRUE
        WHERE c.id=$1
    `, [customerId]);
    if (!result.rowCount) throw new Error('Customer not found.');
    return result.rows[0];
}

async function linkExistingCustomer({ customerId, serverId, jellyfinUserId, makePrimary = true, applyPolicy = false, actorUserId = null }) {
    const [{ server, user }, customer] = await Promise.all([getRemoteUser(serverId, jellyfinUserId), customerSummary(customerId)]);
    if (user.administrator) throw new Error('Jellyfin administrator accounts cannot be linked as customer accounts.');
    assertImportableIdentity(user);
    let plan = null;
    if (customer.plan_id) {
        plan = await loadPlan(customer.plan_id);
        if (makePrimary) await assertServerFitsPlan(server, plan);
    }
    const linked = await transaction(async client => {
        await assertRemoteUnmanaged(client, server.id, user);
        const sameServer = await client.query('SELECT id FROM jellyfin_accounts WHERE customer_id=$1 AND server_id=$2 LIMIT 1 FOR UPDATE', [customerId, server.id]);
        if (sameServer.rowCount) throw new Error('This customer already has a managed account on the selected Jellyfin server.');
        if (makePrimary) await client.query('UPDATE jellyfin_accounts SET is_primary=FALSE,updated_at=NOW() WHERE customer_id=$1 AND is_primary=TRUE', [customerId]);
        const account = await client.query(`
            INSERT INTO jellyfin_accounts(
                customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,last_activity_at,last_policy_sync,is_primary
            ) VALUES($1,$2,$3,$4,FALSE,$5,NULL,$6)
            RETURNING *
        `, [customerId, server.id, user.jellyfin_user_id, cleanName(user.jellyfin_username), user.last_activity_at, Boolean(makePrimary)]);
        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'jellyfin.import.link','customer',$2,$3::jsonb)
        `, [actorUserId || null, customerId, JSON.stringify({ serverId: server.id, jellyfinUserId: user.jellyfin_user_id, jellyfinUsername: user.jellyfin_username, makePrimary: Boolean(makePrimary), applyPolicy: Boolean(applyPolicy) })]);
        return account.rows[0];
    });
    if (applyPolicy && customer.plan_id) await provisioning.reconcileCustomer(customerId);
    return { account: linked, server, user, customer, plan };
}

async function rebindIdentity({ serverId, jellyfinUserId, actorUserId = null }) {
    const { server, user } = await getRemoteUser(serverId, jellyfinUserId);
    if (user.administrator) throw new Error('Administrator identities cannot be rebound as customer accounts.');
    assertImportableIdentity(user);
    return transaction(async client => {
        const exact = await client.query('SELECT id FROM jellyfin_accounts WHERE server_id=$1 AND jellyfin_user_id=$2 LIMIT 1 FOR UPDATE', [server.id, user.jellyfin_user_id]);
        if (exact.rowCount) throw new Error('That Jellyfin identity is already managed.');
        const match = await client.query(`
            SELECT * FROM jellyfin_accounts
            WHERE server_id=$1 AND lower(jellyfin_username)=lower($2)
            LIMIT 1 FOR UPDATE
        `, [server.id, user.jellyfin_username]);
        if (!match.rowCount) throw new Error('No managed account with the same username was found to rebind.');
        const account = match.rows[0];
        const oldUserId = account.jellyfin_user_id;
        await client.query(`
            UPDATE jellyfin_accounts
            SET jellyfin_user_id=$1,disabled=FALSE,last_activity_at=$2,updated_at=NOW()
            WHERE id=$3
        `, [user.jellyfin_user_id, user.last_activity_at, account.id]);
        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'jellyfin.import.rebind','jellyfin_account',$2,$3::jsonb)
        `, [actorUserId || null, account.id, JSON.stringify({ serverId: server.id, username: user.jellyfin_username, oldJellyfinUserId: oldUserId, newJellyfinUserId: user.jellyfin_user_id })]);
        return { ...account, jellyfin_user_id: user.jellyfin_user_id, disabled: false };
    });
}

async function bulkImport({ selected, planId = null, expiresAt = null, applyPolicy = false, actorUserId = null }) {
    const entries = Array.isArray(selected) ? selected : [selected].filter(Boolean);
    if (!entries.length) throw new Error('Select at least one Jellyfin user to import.');
    if (entries.length > 500) throw new Error('Import is limited to 500 users per batch.');
    const results = [];
    for (const encoded of entries) {
        const [serverId, ...idParts] = String(encoded || '').split(':');
        const jellyfinUserId = idParts.join(':');
        try {
            const result = await createImportedCustomer({ serverId, jellyfinUserId, planId, expiresAt, applyPolicy, actorUserId });
            results.push({ ok: true, serverId, jellyfinUserId, customerId: result.customer.id, username: result.user.jellyfin_username });
        } catch (error) {
            results.push({ ok: false, serverId, jellyfinUserId, error: error.message });
        }
    }
    return {
        total: results.length,
        imported: results.filter(result => result.ok).length,
        failed: results.filter(result => !result.ok).length,
        results
    };
}

async function searchCustomers(term = '', limit = 50) {
    const q = String(term || '').trim();
    const result = await query(`
        SELECT c.id,COALESCE(NULLIF(c.display_name,''),NULLIF(au.username,''),'Customer') AS name,
               au.username AS portal_username,COALESCE(NULLIF(au.email,''),NULLIF(c.email,'')) AS email,
               COUNT(ja.id)::int AS jellyfin_accounts
        FROM customers c
        LEFT JOIN app_users au ON au.id=c.user_id
        LEFT JOIN jellyfin_accounts ja ON ja.customer_id=c.id
        WHERE $1='' OR c.display_name ILIKE '%'||$1||'%' OR au.username ILIKE '%'||$1||'%' OR au.email ILIKE '%'||$1||'%' OR c.email ILIKE '%'||$1||'%'
        GROUP BY c.id,au.username,au.email
        ORDER BY name
        LIMIT $2
    `, [q, Math.max(1, Math.min(Number(limit) || 50, 100))]);
    return result.rows;
}

module.exports = {
    discover,
    getRemoteUser,
    createImportedCustomer,
    linkExistingCustomer,
    rebindIdentity,
    bulkImport,
    searchCustomers,
    assertServerFitsPlan,
    expiryForPlan,
    assertImportableIdentity
};