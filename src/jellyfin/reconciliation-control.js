'use strict';

const crypto = require('crypto');
const { query } = require('../db');

const VERIFY_INTERVAL_MS = 30 * 60 * 1000;
const BLOCKED_RETRY_MINUTES = 10;
const RUNNING_STALE_MINUTES = 15;
const FAILURE_RETRY_MINUTES = [1, 2, 5, 10, 30, 60];

const POLICY_KEYS = [
    'IsAdministrator', 'IsHidden', 'IsDisabled', 'EnableAllDevices',
    'EnableAllFolders', 'EnabledFolders', 'EnableAllChannels', 'EnableRemoteAccess',
    'EnableMediaPlayback', 'EnableAudioPlaybackTranscoding',
    'EnableVideoPlaybackTranscoding', 'EnablePlaybackRemuxing',
    'EnableContentDownloading', 'EnableSyncTranscoding', 'EnableMediaConversion',
    'EnableContentDeletion', 'EnableRemoteControlOfOtherUsers',
    'EnableSharedDeviceControl', 'EnableLiveTvManagement', 'EnableLiveTvAccess',
    'EnableSubtitleManagement',
    'EnableUserPreferenceAccess', 'AuthenticationProviderId',
    'PasswordResetProviderId', 'SyncPlayAccess'
];

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((out, key) => {
        out[key] = stable(value[key]);
        return out;
    }, {});
}

function policySnapshot(value) {
    const source = value?.Policy && typeof value.Policy === 'object' ? value.Policy : (value || {});
    const out = {};
    for (const key of POLICY_KEYS) {
        let item = source[key];
        if (key === 'EnabledFolders') item = Array.isArray(item) ? item.map(String).sort() : [];
        out[key] = item;
    }
    return out;
}

function policyHash(body) {
    return crypto.createHash('sha256').update(JSON.stringify(stable(policySnapshot(body)))).digest('hex');
}

function policyMatches(remote, desired) {
    return JSON.stringify(stable(policySnapshot(remote))) === JSON.stringify(stable(policySnapshot(desired)));
}

function verificationFresh(lastVerifiedAt, now = Date.now()) {
    if (!lastVerifiedAt) return false;
    const timestamp = new Date(lastVerifiedAt).getTime();
    return Number.isFinite(timestamp) && now - timestamp < VERIFY_INTERVAL_MS;
}

function retryDelayMinutes(consecutiveFailures) {
    const count = Math.max(1, Number(consecutiveFailures) || 1);
    return FAILURE_RETRY_MINUTES[Math.min(count - 1, FAILURE_RETRY_MINUTES.length - 1)];
}

function classifyError(error) {
    const message = String(error?.message || error || 'Unknown provisioning error');
    if (/no eligible jellyfin server|no jellyfin server|missing on server|plan .* no eligible/i.test(message)) {
        return { status: 'blocked', message };
    }
    return { status: 'failed', message };
}

async function getCustomerState(customerId) {
    const result = await query('SELECT * FROM customer_provisioning_state WHERE customer_id=$1', [customerId]);
    return result.rows[0] || null;
}

async function markCustomerRunning(customerId, entitlement = null) {
    await query(`
        INSERT INTO customer_provisioning_state(
            customer_id,status,attempt_count,last_attempt_at,next_attempt_at,subscription_id,plan_id,updated_at
        ) VALUES($1,'running',1,NOW(),NOW()+make_interval(mins=>$4),$2,$3,NOW())
        ON CONFLICT (customer_id) DO UPDATE SET
            status='running',
            attempt_count=customer_provisioning_state.attempt_count+1,
            last_attempt_at=NOW(),
            next_attempt_at=NOW()+make_interval(mins=>$4),
            subscription_id=EXCLUDED.subscription_id,
            plan_id=EXCLUDED.plan_id,
            updated_at=NOW()
    `, [customerId, entitlement?.subscription_id || null, entitlement?.plan_id || null, RUNNING_STALE_MINUTES]);
}

async function markCustomerHealthy(customerId, detail = {}) {
    await query(`
        INSERT INTO customer_provisioning_state(
            customer_id,status,last_success_at,next_attempt_at,last_result,updated_at,
            jellyfin_account_id,server_id,subscription_id,plan_id
        ) VALUES($1,'healthy',NOW(),NOW()+INTERVAL '30 minutes',$2::jsonb,NOW(),$3,$4,$5,$6)
        ON CONFLICT (customer_id) DO UPDATE SET
            status='healthy',consecutive_failures=0,last_error=NULL,last_success_at=NOW(),
            next_attempt_at=NOW()+INTERVAL '30 minutes',last_result=EXCLUDED.last_result,
            jellyfin_account_id=EXCLUDED.jellyfin_account_id,server_id=EXCLUDED.server_id,
            subscription_id=EXCLUDED.subscription_id,plan_id=EXCLUDED.plan_id,updated_at=NOW()
    `, [
        customerId,
        JSON.stringify(detail.result || {}),
        detail.accountId || null,
        detail.serverId || null,
        detail.subscriptionId || null,
        detail.planId || null
    ]);
}

async function markCustomerProblem(customerId, status, error, detail = {}) {
    if (!['blocked', 'failed'].includes(status)) throw new Error('Invalid customer provisioning problem status');
    const current = await getCustomerState(customerId);
    const nextFailures = status === 'failed' ? Number(current?.consecutive_failures || 0) + 1 : Number(current?.consecutive_failures || 0);
    const minutes = status === 'blocked' ? BLOCKED_RETRY_MINUTES : retryDelayMinutes(nextFailures);
    await query(`
        INSERT INTO customer_provisioning_state(
            customer_id,status,consecutive_failures,last_error,next_attempt_at,last_result,updated_at,
            subscription_id,plan_id,jellyfin_account_id,server_id
        ) VALUES($1,$2,$3,$4,NOW()+make_interval(mins=>$5),$6::jsonb,NOW(),$7,$8,$9,$10)
        ON CONFLICT (customer_id) DO UPDATE SET
            status=EXCLUDED.status,
            consecutive_failures=EXCLUDED.consecutive_failures,
            last_error=EXCLUDED.last_error,
            next_attempt_at=EXCLUDED.next_attempt_at,
            last_result=EXCLUDED.last_result,
            subscription_id=COALESCE(EXCLUDED.subscription_id,customer_provisioning_state.subscription_id),
            plan_id=COALESCE(EXCLUDED.plan_id,customer_provisioning_state.plan_id),
            jellyfin_account_id=COALESCE(EXCLUDED.jellyfin_account_id,customer_provisioning_state.jellyfin_account_id),
            server_id=COALESCE(EXCLUDED.server_id,customer_provisioning_state.server_id),
            updated_at=NOW()
    `, [
        customerId, status, nextFailures, String(error?.message || error || 'Unknown provisioning error').slice(0, 1000), minutes,
        JSON.stringify(detail.result || {}), detail.subscriptionId || null, detail.planId || null,
        detail.accountId || null, detail.serverId || null
    ]);
}

async function forceCustomerDue(customerId) {
    await query(`
        INSERT INTO customer_provisioning_state(customer_id,status,next_attempt_at,updated_at)
        VALUES($1,'pending',NOW(),NOW())
        ON CONFLICT (customer_id) DO UPDATE SET status='pending',next_attempt_at=NOW(),updated_at=NOW()
    `, [customerId]);
}

async function forceAllProblemsDue() {
    const result = await query(`
        UPDATE customer_provisioning_state
        SET status='pending',next_attempt_at=NOW(),updated_at=NOW()
        WHERE status IN ('blocked','failed')
        RETURNING customer_id
    `);
    return result.rowCount;
}

async function getAccountState(accountId) {
    const result = await query('SELECT * FROM jellyfin_policy_reconciliation WHERE jellyfin_account_id=$1', [accountId]);
    return result.rows[0] || null;
}

async function markAccountRunning(accountId, customerId, desiredHash = null) {
    await query(`
        INSERT INTO jellyfin_policy_reconciliation(
            jellyfin_account_id,customer_id,status,requested_at,desired_policy_hash,updated_at
        ) VALUES($1,$2,'running',NOW(),$3,NOW())
        ON CONFLICT (jellyfin_account_id) DO UPDATE SET
            status='running',customer_id=EXCLUDED.customer_id,
            desired_policy_hash=COALESCE(EXCLUDED.desired_policy_hash,jellyfin_policy_reconciliation.desired_policy_hash),
            requested_at=NOW(),updated_at=NOW()
    `, [accountId, customerId, desiredHash]);
}

async function markAccountSuccess(accountId, customerId, desiredHash, { verified = true } = {}) {
    await query(`
        INSERT INTO jellyfin_policy_reconciliation(
            jellyfin_account_id,customer_id,status,attempt_count,last_attempt_at,last_success_at,
            last_verified_at,desired_policy_hash,applied_policy_hash,consecutive_failures,next_retry_at,last_error,updated_at
        ) VALUES($1,$2,'successful',1,NOW(),NOW(),CASE WHEN $4 THEN NOW() ELSE NULL END,$3,$3,0,NULL,NULL,NOW())
        ON CONFLICT (jellyfin_account_id) DO UPDATE SET
            status='successful',attempt_count=jellyfin_policy_reconciliation.attempt_count+1,
            last_attempt_at=NOW(),last_success_at=NOW(),
            last_verified_at=CASE WHEN $4 THEN NOW() ELSE jellyfin_policy_reconciliation.last_verified_at END,
            desired_policy_hash=$3,applied_policy_hash=$3,consecutive_failures=0,
            next_retry_at=NULL,last_error=NULL,updated_at=NOW()
    `, [accountId, customerId, desiredHash, Boolean(verified)]);
}

async function markAccountVerified(accountId, customerId, desiredHash) {
    await query(`
        UPDATE jellyfin_policy_reconciliation
        SET status='successful',customer_id=$2,last_verified_at=NOW(),last_success_at=NOW(),
            desired_policy_hash=$3,applied_policy_hash=$3,consecutive_failures=0,
            next_retry_at=NULL,last_error=NULL,updated_at=NOW()
        WHERE jellyfin_account_id=$1
    `, [accountId, customerId, desiredHash]);
}

async function markAccountDrift(accountId, customerId, desiredHash) {
    await query(`
        INSERT INTO jellyfin_policy_reconciliation(
            jellyfin_account_id,customer_id,status,desired_policy_hash,drift_detected_at,updated_at
        ) VALUES($1,$2,'running',$3,NOW(),NOW())
        ON CONFLICT (jellyfin_account_id) DO UPDATE SET
            status='running',customer_id=EXCLUDED.customer_id,desired_policy_hash=$3,
            drift_detected_at=NOW(),updated_at=NOW()
    `, [accountId, customerId, desiredHash]);
}

async function markAccountFailure(accountId, customerId, desiredHash, error) {
    const current = await getAccountState(accountId);
    const failures = Number(current?.consecutive_failures || 0) + 1;
    const minutes = retryDelayMinutes(failures);
    await query(`
        INSERT INTO jellyfin_policy_reconciliation(
            jellyfin_account_id,customer_id,status,attempt_count,last_error,last_attempt_at,
            desired_policy_hash,consecutive_failures,next_retry_at,updated_at
        ) VALUES($1,$2,'failed',1,$4,NOW(),$3,$5,NOW()+make_interval(mins=>$6),NOW())
        ON CONFLICT (jellyfin_account_id) DO UPDATE SET
            status='failed',customer_id=EXCLUDED.customer_id,
            attempt_count=jellyfin_policy_reconciliation.attempt_count+1,last_error=$4,last_attempt_at=NOW(),
            desired_policy_hash=$3,consecutive_failures=$5,next_retry_at=EXCLUDED.next_retry_at,updated_at=NOW()
    `, [accountId, customerId, desiredHash, String(error?.message || error || 'Unknown Jellyfin policy error').slice(0, 1000), failures, minutes]);
}

module.exports = {
    VERIFY_INTERVAL_MS,
    BLOCKED_RETRY_MINUTES,
    RUNNING_STALE_MINUTES,
    POLICY_KEYS,
    policySnapshot,
    policyHash,
    policyMatches,
    verificationFresh,
    retryDelayMinutes,
    classifyError,
    getCustomerState,
    markCustomerRunning,
    markCustomerHealthy,
    markCustomerProblem,
    forceCustomerDue,
    forceAllProblemsDue,
    getAccountState,
    markAccountRunning,
    markAccountSuccess,
    markAccountVerified,
    markAccountDrift,
    markAccountFailure
};
