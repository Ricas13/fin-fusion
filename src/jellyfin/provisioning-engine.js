'use strict';

const crypto = require('crypto');
const { query, transaction } = require('../db');
const registry = require('./registry');
const policy = require('./policy');
const planServers = require('./plan-servers');
const compensation = require('./provisioning-compensation');

// Low-level Jellyfin primitives only. Customer reconciliation, entitlement
// selection, access holds and subscription expiry are intentionally owned by
// the canonical multi-service layers and must not be reintroduced here.

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

async function libraryCatalogForServerClass(serverClass) {
    const result = await query(`
        SELECT id,name FROM jellyfin_servers
        WHERE enabled=TRUE AND server_class=$1 ORDER BY priority,name
    `, [serverClass]);
    return libraryCatalogFromServers(result.rows);
}

async function libraryCatalogForPlan(plan) {
    if (!plan) return { names: [], failedServers: [], serverCount: 0 };
    // Library policy should reflect servers that may actually receive a new
    // account under the current placement/health policy.
    const servers = await planServers.eligibleServersForPlan(plan, { enabledOnly: true, forPlacement: true });
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
        EnableSubtitleManagement: enabled && Boolean(effectiveTechnical.allow_subtitle_editing),
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

async function preferredUsername(customerId) {
    const result = await query(`
        SELECT COALESCE(NULLIF(c.display_name,''),u.username,'user') AS username
        FROM customers c LEFT JOIN app_users u ON u.id=c.user_id
        WHERE c.id=$1
    `, [customerId]);
    if (!result.rowCount) throw new Error('Customer not found');
    return String(result.rows[0].username || 'user').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'user';
}

async function usernameAvailable(serverId, preferred) {
    const users = await registry.request(serverId, '/Users');
    const names = new Set((Array.isArray(users) ? users : []).map(u => String(u.Name || '').toLowerCase()));
    return !names.has(String(preferred || '').toLowerCase());
}

function cleanJellyfinUsername(value) {
    const username = String(value || '').trim();
    if (!/^[A-Za-z0-9._@+-]{3,80}$/.test(username)) {
        throw new Error('Jellyfin username must be 3-80 characters using letters, numbers, dot, underscore, dash, plus or @.');
    }
    return username;
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

async function markPrimaryAccount(customerId, accountId) {
    await transaction(async client => {
        const exists = await client.query('SELECT id FROM jellyfin_accounts WHERE id=$1 AND customer_id=$2 FOR UPDATE', [accountId, customerId]);
        if (!exists.rowCount) throw new Error('Jellyfin account not found');
        await client.query('UPDATE jellyfin_accounts SET is_primary=FALSE,updated_at=NOW() WHERE customer_id=$1 AND is_primary=TRUE AND id<>$2', [customerId, accountId]);
        await client.query('UPDATE jellyfin_accounts SET is_primary=TRUE,updated_at=NOW() WHERE id=$1', [accountId]);
    });
}

async function createJellyfinAccount(customerId, server, effective, options = {}) {
    const preferred = String(options.preferredUsername || await preferredUsername(customerId)).slice(0, 40);
    let username;
    if (options.requireExactUsername) {
        if (!(await usernameAvailable(server.id, preferred))) {
            const error = new Error(`Username ${preferred} already exists on target Jellyfin server`);
            error.code = 'TARGET_USERNAME_EXISTS';
            throw error;
        }
        username = preferred;
    } else {
        username = await uniqueUsername(server.id, preferred);
    }
    const bootstrapPassword = options.bootstrapPassword || randomPassword();
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
        await compensation.removeCreatedUser({ customerId, serverId: server.id, userId: created.Id, stage: 'policy_apply', originalError: error });
        throw compensation.rolledBackError(
            'Jellyfin account creation could not be completed while applying access policy. The remote account was rolled back.',
            'JELLYFIN_POLICY_APPLY_FAILED',
            error
        );
    }

    let stored;
    try {
        stored = await query(`
            INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,last_policy_sync,is_primary)
            VALUES($1,$2,$3,$4,FALSE,NOW(),FALSE)
            RETURNING *
        `, [customerId, server.id, created.Id, username]);
    } catch (error) {
        await compensation.removeCreatedUser({ customerId, serverId: server.id, userId: created.Id, stage: 'database_persist', originalError: error });
        throw compensation.rolledBackError(
            'Jellyfin account creation could not be persisted. The remote account was rolled back.',
            'JELLYFIN_ACCOUNT_PERSIST_FAILED',
            error
        );
    }
    const account = stored.rows[0];
    if (libraryAccess.missing.length) {
        const message = `Missing on server: ${libraryAccess.missing.join(', ')}`;
        await upsertReconciliationStatus(account.id, customerId, 'failed', message);
        throw new Error(`Jellyfin account created with a narrowed library set -- ${message}`);
    }
    await upsertReconciliationStatus(account.id, customerId, 'successful', null);
    if (options.makePrimary !== false) {
        await markPrimaryAccount(customerId, account.id);
        account.is_primary = true;
    }
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

async function disableJellyfinAccount(account) {
    return applyPolicy(account, DISABLED_EFFECTIVE, true);
}

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
        `, [id, JSON.stringify({ error: error.message, errorCode: error.code || null })]);
        throw error;
    }
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

async function renameJellyfinAccount(customerId, accountId, newUsername, { actorUserId = null } = {}) {
    const username = cleanJellyfinUsername(newUsername);
    const result = await query(`SELECT ja.*,ja.created_at<CURRENT_DATE AS can_rename_jellyfin_username FROM jellyfin_accounts ja WHERE ja.id=$1 AND ja.customer_id=$2 AND ja.account_purpose='jellyfin'`, [accountId, customerId]);
    if (!result.rowCount) throw new Error('Jellyfin account not found');
    const account = result.rows[0];
    if (!account.can_rename_jellyfin_username) throw new Error('Jellyfin username changes are only available for accounts created before today.');
    if (String(account.jellyfin_username || '').toLowerCase() === username.toLowerCase()) return account;
    const local = await query(`SELECT 1 FROM jellyfin_accounts WHERE server_id=$1 AND lower(jellyfin_username)=lower($2) AND id<>$3 LIMIT 1`, [account.server_id, username, account.id]);
    if (local.rowCount) throw new Error('That Jellyfin username is already used on this server.');
    if (!(await usernameAvailable(account.server_id, username))) throw new Error('That Jellyfin username is already used on this server.');
    return recordRun(customerId, null, 'username_change', async () => {
        await registry.request(account.server_id, `/Users/${account.jellyfin_user_id}`, {
            method: 'POST',
            body: { Id: account.jellyfin_user_id, Name: username }
        });
        const updated = await query(`UPDATE jellyfin_accounts SET jellyfin_username=$3,updated_at=NOW() WHERE id=$1 AND customer_id=$2 RETURNING *`, [accountId, customerId, username]);
        await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'customer.jellyfin.username_change','jellyfin_account',$2,$3::jsonb)`, [actorUserId, accountId, JSON.stringify({ previousUsername: account.jellyfin_username, newUsername: username, serverId: account.server_id, jellyfinUserId: account.jellyfin_user_id })]);
        return updated.rows[0];
    });
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
    policyBody,
    resolveLibraryAccessForServer,
    usernameAvailable,
    createJellyfinAccount,
    applyPolicy,
    disableJellyfinAccount,
    markPrimaryAccount,
    setJellyfinPassword,
    renameJellyfinAccount
};
