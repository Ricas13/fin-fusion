'use strict';

const crypto = require('crypto');
const { query } = require('../db');
const registry = require('./registry');
const provisioning = require('./provisioning');
const policy = require('./policy');

const CONTROLLED_FIELDS = [
    'IsAdministrator','IsHidden','IsDisabled','EnableAllDevices','EnableAllFolders','EnabledFolders',
    'EnableAllChannels','EnableRemoteAccess','EnableMediaPlayback','EnableAudioPlaybackTranscoding',
    'EnableVideoPlaybackTranscoding','EnablePlaybackRemuxing','EnableContentDownloading','EnableSyncTranscoding',
    'EnableMediaConversion','EnableContentDeletion','EnableRemoteControlOfOtherUsers','EnableSharedDeviceControl',
    'EnableLiveTvManagement','EnableLiveTvAccess','EnableUserPreferenceAccess','SyncPlayAccess'
];

const DISABLED_TECHNICAL = policy.flattenEffective(policy.effectiveTechnicalPolicy(null, null));

function intEnv(name, fallback, min, max) {
    const value = Number.parseInt(process.env[name] || '', 10);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
}
function healthyIntervalMs() { return intEnv('JELLYFIN_DRIFT_HEALTHY_MINUTES', 360, 30, 1440) * 60 * 1000; }
function driftIntervalMs() { return intEnv('JELLYFIN_DRIFT_RECHECK_MINUTES', 60, 15, 720) * 60 * 1000; }
function failureDelayMs(failures) {
    const base = 15 * 60 * 1000;
    return Math.min(6 * 60 * 60 * 1000, base * (2 ** Math.min(5, Math.max(0, Number(failures || 1) - 1))));
}
function hash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function normalizeValue(field, value) {
    if (field === 'EnabledFolders') return Array.from(new Set(Array.isArray(value) ? value.map(String) : [])).sort();
    if (field === 'SyncPlayAccess') return String(value || 'None');
    return Boolean(value);
}
function normalizedPolicy(source) {
    const output = {};
    for (const field of CONTROLLED_FIELDS) output[field] = normalizeValue(field, source?.[field]);
    return output;
}
function sameValue(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a || []) === JSON.stringify(b || []);
    return a === b;
}
function comparePolicy({ desiredPolicy, remotePolicy, expectedUsername, remoteUsername, missingLibraries = [] }) {
    const desired = normalizedPolicy(desiredPolicy);
    const remote = normalizedPolicy(remotePolicy);
    const differences = [];
    if (String(remoteUsername || '') !== String(expectedUsername || '')) {
        differences.push({ field: 'Username', expected: String(expectedUsername || ''), actual: String(remoteUsername || '') });
    }
    for (const field of CONTROLLED_FIELDS) {
        if (!sameValue(desired[field], remote[field])) differences.push({ field, expected: desired[field], actual: remote[field] });
    }
    if (missingLibraries.length) {
        differences.push({ field: 'MissingLibraries', expected: [], actual: missingLibraries.map(String).sort() });
    }
    return { desired, remote, differences, desiredHash: hash({ username: expectedUsername, policy: desired }), remoteHash: hash({ username: remoteUsername, policy: remote }) };
}

async function ensureRows() {
    await query(`
        INSERT INTO jellyfin_policy_drift(jellyfin_account_id,customer_id,server_id,status,next_check_at)
        SELECT ja.id,ja.customer_id,ja.server_id,'unknown',NOW()
        FROM jellyfin_accounts ja
        ON CONFLICT(jellyfin_account_id) DO UPDATE SET
            customer_id=EXCLUDED.customer_id,server_id=EXCLUDED.server_id
    `);
}

async function customerContext(customerId, catalogCache = new Map()) {
    const [entitlement, accountsResult] = await Promise.all([
        provisioning.currentEntitlement(customerId),
        query(`
            SELECT ja.*,js.enabled AS server_enabled,js.server_class,js.name AS server_name
            FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id
            WHERE ja.customer_id=$1
            ORDER BY ja.is_primary DESC,ja.disabled ASC,ja.created_at ASC
        `, [customerId])
    ]);
    const accounts = accountsResult.rows;
    let activeAccount = null;
    let effective = null;
    if (entitlement) {
        activeAccount = accounts.find(a => a.is_primary && a.server_class === entitlement.server_class && a.server_enabled)
            || accounts.find(a => !a.disabled && a.server_class === entitlement.server_class && a.server_enabled)
            || accounts.find(a => a.server_class === entitlement.server_class && a.server_enabled)
            || null;

        const [override, libOverrides, selection] = await Promise.all([
            provisioning.getPolicyOverride(customerId),
            provisioning.getLibraryOverrides(customerId),
            provisioning.getLibrarySelection(customerId)
        ]);
        const planKey = String(entitlement.plan_id || entitlement.id || entitlement.code);
        let catalog = catalogCache.get(planKey);
        if (!catalog) {
            catalog = await provisioning.libraryCatalogForPlan(entitlement);
            catalogCache.set(planKey, catalog);
        }
        const technicalRows = policy.effectiveTechnicalPolicy(entitlement, override);
        const entitlementRows = policy.libraryEntitlement(entitlement, libOverrides, catalog.names);
        const visibleNames = policy.customerVisibleLibraries(entitlementRows, selection);
        const mode = ['all','exclude','include'].includes(entitlement.library_access_mode) ? entitlement.library_access_mode : 'all';
        effective = {
            technical: policy.flattenEffective(technicalRows),
            visibleNames,
            unrestricted: mode === 'all' && libOverrides.length === 0 && !selection,
            catalog
        };
    }
    return { customerId, entitlement, accounts, activeAccount, effective };
}

async function desiredState(account, context) {
    const disabled = !context.entitlement || !context.activeAccount || String(context.activeAccount.id) !== String(account.id);
    if (disabled) {
        return {
            disabled: true,
            policy: provisioning.policyBody(DISABLED_TECHNICAL, true, { enableAllFolders: false, enabledFolders: [] }),
            missingLibraries: []
        };
    }
    const libraryAccess = await provisioning.resolveLibraryAccessForServer(
        account.server_id,
        context.effective.unrestricted,
        context.effective.visibleNames,
        false
    );
    return {
        disabled: false,
        policy: provisioning.policyBody(context.effective.technical, false, libraryAccess),
        missingLibraries: libraryAccess.missing || []
    };
}

async function persistSuccess(account, desired, comparison) {
    const status = comparison.differences.length ? 'drift' : 'in_sync';
    const now = new Date();
    const next = new Date(now.getTime() + (status === 'drift' ? driftIntervalMs() : healthyIntervalMs()));
    await query(`
        INSERT INTO jellyfin_policy_drift(
            jellyfin_account_id,customer_id,server_id,status,desired_disabled,desired_hash,remote_hash,differences,
            last_checked_at,last_success_at,last_error,consecutive_failures,next_check_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$9,NULL,0,$10,NOW())
        ON CONFLICT(jellyfin_account_id) DO UPDATE SET
            customer_id=EXCLUDED.customer_id,server_id=EXCLUDED.server_id,status=EXCLUDED.status,
            desired_disabled=EXCLUDED.desired_disabled,desired_hash=EXCLUDED.desired_hash,remote_hash=EXCLUDED.remote_hash,
            differences=EXCLUDED.differences,last_checked_at=EXCLUDED.last_checked_at,last_success_at=EXCLUDED.last_success_at,
            last_error=NULL,consecutive_failures=0,next_check_at=EXCLUDED.next_check_at,updated_at=NOW()
    `, [account.id,account.customer_id,account.server_id,status,desired.disabled,comparison.desiredHash,comparison.remoteHash,JSON.stringify(comparison.differences),now,next]);
    return { accountId: account.id, customerId: account.customer_id, status, differences: comparison.differences, nextCheckAt: next };
}

async function persistFailure(account, status, error) {
    const prior = await query('SELECT consecutive_failures FROM jellyfin_policy_drift WHERE jellyfin_account_id=$1', [account.id]);
    const failures = Number(prior.rows[0]?.consecutive_failures || 0) + 1;
    const now = new Date();
    const next = new Date(now.getTime() + failureDelayMs(failures));
    await query(`
        INSERT INTO jellyfin_policy_drift(
            jellyfin_account_id,customer_id,server_id,status,differences,last_checked_at,last_error,
            consecutive_failures,next_check_at,updated_at
        ) VALUES($1,$2,$3,$4,'[]'::jsonb,$5,$6,$7,$8,NOW())
        ON CONFLICT(jellyfin_account_id) DO UPDATE SET
            customer_id=EXCLUDED.customer_id,server_id=EXCLUDED.server_id,status=EXCLUDED.status,
            differences='[]'::jsonb,last_checked_at=EXCLUDED.last_checked_at,last_error=EXCLUDED.last_error,
            consecutive_failures=EXCLUDED.consecutive_failures,next_check_at=EXCLUDED.next_check_at,updated_at=NOW()
    `, [account.id,account.customer_id,account.server_id,status,now,String(error?.message || error).slice(0,1500),failures,next]);
    return { accountId: account.id, customerId: account.customer_id, status, error: String(error?.message || error), failures, nextCheckAt: next };
}

async function auditAccount(accountId, { context = null, catalogCache = new Map() } = {}) {
    const accountResult = await query(`
        SELECT ja.*,js.enabled AS server_enabled,js.server_class,js.name AS server_name
        FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id
        WHERE ja.id=$1
    `, [accountId]);
    if (!accountResult.rowCount) throw new Error('Jellyfin account not found.');
    const account = accountResult.rows[0];
    const ctx = context || await customerContext(account.customer_id, catalogCache);
    let desired;
    try {
        desired = await desiredState(account, ctx);
        const remote = await registry.request(account.server_id, `/Users/${encodeURIComponent(account.jellyfin_user_id)}`, { timeoutMs: 10000 });
        if (!remote || typeof remote !== 'object' || !remote.Policy) throw new Error('Jellyfin returned an unexpected user record.');
        const comparison = comparePolicy({
            desiredPolicy: desired.policy,
            remotePolicy: remote.Policy,
            expectedUsername: account.jellyfin_username,
            remoteUsername: remote.Name,
            missingLibraries: desired.missingLibraries
        });
        return persistSuccess(account, desired, comparison);
    } catch (error) {
        const message = String(error?.message || error);
        const status = /\b404\b|not found/i.test(message) ? 'missing' : 'unreachable';
        return persistFailure(account, status, error);
    }
}

async function dueAccounts({ all = false, limit = 100 } = {}) {
    await ensureRows();
    const result = await query(`
        SELECT d.jellyfin_account_id,d.customer_id
        FROM jellyfin_policy_drift d
        JOIN jellyfin_accounts ja ON ja.id=d.jellyfin_account_id
        JOIN jellyfin_servers js ON js.id=ja.server_id
        WHERE js.enabled=TRUE AND ($1::boolean OR d.next_check_at<=NOW())
        ORDER BY d.next_check_at,d.updated_at
        LIMIT $2
    `, [Boolean(all), Math.max(1, Math.min(1000, Number(limit) || 100))]);
    return result.rows;
}

async function auditDue({ all = false, limit = 100 } = {}) {
    const rows = await dueAccounts({ all, limit });
    const contexts = new Map();
    const catalogCache = new Map();
    const summary = { total: rows.length, inSync: 0, drift: 0, unreachable: 0, missing: 0, results: [] };
    for (const row of rows) {
        const customerId = String(row.customer_id);
        let context = contexts.get(customerId);
        if (!context) {
            try {
                context = await customerContext(row.customer_id, catalogCache);
                contexts.set(customerId, context);
            } catch (error) {
                const account = (await query('SELECT * FROM jellyfin_accounts WHERE id=$1', [row.jellyfin_account_id])).rows[0];
                const result = await persistFailure(account, 'unreachable', error);
                summary.results.push(result); summary.unreachable += 1;
                continue;
            }
        }
        const result = await auditAccount(row.jellyfin_account_id, { context, catalogCache });
        summary.results.push(result);
        if (result.status === 'in_sync') summary.inSync += 1;
        else if (result.status === 'drift') summary.drift += 1;
        else if (result.status === 'missing') summary.missing += 1;
        else summary.unreachable += 1;
    }
    return summary;
}

async function listAuditRows() {
    await ensureRows();
    const result = await query(`
        SELECT d.*,ja.jellyfin_username,ja.jellyfin_user_id,ja.disabled,ja.is_primary,ja.last_policy_sync,
               js.name AS server_name,js.slug AS server_slug,js.health_status,
               c.display_name,c.email,u.username AS portal_username,
               p.name AS plan_name,p.code AS plan_code
        FROM jellyfin_policy_drift d
        JOIN jellyfin_accounts ja ON ja.id=d.jellyfin_account_id
        JOIN jellyfin_servers js ON js.id=ja.server_id
        JOIN customers c ON c.id=ja.customer_id
        LEFT JOIN app_users u ON u.id=c.user_id
        LEFT JOIN LATERAL (
            SELECT p.* FROM subscriptions s JOIN plans p ON p.id=s.plan_id
            WHERE s.customer_id=c.id AND s.status IN ('active','trialing','past_due') AND s.current_period_end>NOW() AND p.active=TRUE
            ORDER BY s.current_period_end DESC,s.created_at DESC LIMIT 1
        ) p ON TRUE
        ORDER BY CASE d.status WHEN 'drift' THEN 0 WHEN 'missing' THEN 1 WHEN 'unreachable' THEN 2 WHEN 'unknown' THEN 3 ELSE 4 END,
                 d.updated_at DESC,c.display_name,js.name
    `);
    return result.rows;
}

async function stats() {
    await ensureRows();
    const result = await query(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER(WHERE status='in_sync')::int AS in_sync,
               COUNT(*) FILTER(WHERE status='drift')::int AS drift,
               COUNT(*) FILTER(WHERE status='unreachable')::int AS unreachable,
               COUNT(*) FILTER(WHERE status='missing')::int AS missing,
               COUNT(*) FILTER(WHERE status='unknown')::int AS unknown
        FROM jellyfin_policy_drift
    `);
    return result.rows[0];
}

async function clearForCustomer(customerId) {
    await query('UPDATE jellyfin_policy_drift SET status=\'unknown\',next_check_at=NOW(),updated_at=NOW() WHERE customer_id=$1', [customerId]);
}

module.exports = {
    CONTROLLED_FIELDS,
    normalizeValue,
    normalizedPolicy,
    comparePolicy,
    ensureRows,
    customerContext,
    desiredState,
    auditAccount,
    auditDue,
    dueAccounts,
    listAuditRows,
    stats,
    clearForCustomer,
    healthyIntervalMs,
    driftIntervalMs,
    failureDelayMs
};
