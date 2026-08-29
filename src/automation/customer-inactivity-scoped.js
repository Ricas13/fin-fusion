'use strict';

const { query, transaction } = require('../db');
const accessHolds = require('../entitlements/access-holds');
const lifecyclePolicy = require('../entitlements/jellyfin-lifecycle-policy');
const planPolicy = require('../entitlements/plan-lifecycle-policy');
const provisioning = require('../jellyfin/resilient-provisioning');
const activityTrust = require('../jellyfin/activity-trust');
const fleetMetrics = require('../jellyfin/fleet-metrics');
const registry = require('../jellyfin/registry');
const base = require('./customer-inactivity');

async function activityWorkerTelemetry() {
    return activityTrust.workerTelemetry();
}

function candidateServerIds(rows) {
    return [...new Set((rows || [])
        .map(row => row?.server_id == null ? null : String(row.server_id))
        .filter(Boolean))];
}

// Playback trust comes only from the activity worker's /Sessions poll ledger.
// A successful /Users refresh below is additional freshness evidence; it must
// never promote a failed/stale playback sample back to ready.
async function refreshCandidateServers(rows, existing = {}) {
    const current = await activityTrust.serverTelemetry(candidateServerIds(rows));
    return { ...existing, ...current };
}

async function refreshCandidateUserActivity(rows, serverTelemetry = {}) {
    const telemetry = { ...serverTelemetry };
    for (const serverId of candidateServerIds(rows)) {
        const poll = telemetry[serverId];
        if (!poll?.ready) continue;
        try {
            const refreshed = await fleetMetrics.refreshServerUserActivity(serverId);
            telemetry[serverId] = { ...poll, userActivityReady: true, userActivity: refreshed };
        } catch (error) {
            telemetry[serverId] = {
                ...poll,
                ready: false,
                reason: 'user_activity_refresh_failed',
                userActivityReady: false,
                error: String(error?.message || error).slice(0, 1000)
            };
        }
    }
    return telemetry;
}

function eligibleOnReadyServers(rows, serverTelemetry) {
    return (rows || []).filter(row => {
        if (!row?.eligible) return false;
        const server = serverTelemetry?.[String(row.server_id)];
        return Boolean(server?.ready);
    });
}

function telemetrySummary(worker, serverTelemetry) {
    const servers = Object.entries(serverTelemetry || {}).map(([serverId, value]) => ({ serverId, ...value }));
    const unsafe = servers.filter(server => !server.ready);
    return {
        ready: Boolean(worker?.ready && unsafe.length === 0),
        activityWorkerAgeSeconds: worker?.activityWorkerAgeSeconds ?? null,
        targetServers: servers.length,
        unsafeTargetServers: unsafe.length,
        servers
    };
}

function deletionPolicy(globalCfg, inactivityPolicy) {
    return lifecyclePolicy.deleteDays(globalCfg, 'free', { inactivity_policy: inactivityPolicy || {} });
}

async function recordDisabledLifecycle(row, evidence, globalCfg) {
    const deletion = deletionPolicy(globalCfg, row.inactivity_policy);
    const state = await query("SELECT disabled FROM jellyfin_accounts WHERE id=$1 AND access_lane='free' AND account_purpose='jellyfin'", [row.account_id]);
    if (!state.rowCount || state.rows[0].disabled !== true) {
        throw new Error('Free Server account did not reach disabled state; lifecycle deletion was not scheduled');
    }
    const now = new Date();
    const deleteAfter = new Date(now.getTime() + deletion.days * 86400000);
    const ledger = await query(`
        INSERT INTO jellyfin_account_lifecycle(
            account_id,customer_id,server_id,jellyfin_user_id,jellyfin_username,
            category,reason,policy_source,disabled_at,delete_after,metadata
        ) VALUES($1,$2,$3,$4,$5,'free',$6,$7,$8,$9,$10::jsonb)
        ON CONFLICT(account_id) DO UPDATE SET
            category='free',
            reason=EXCLUDED.reason,
            policy_source=EXCLUDED.policy_source,
            disabled_at=CASE
                WHEN jellyfin_account_lifecycle.restored_at IS NOT NULL OR jellyfin_account_lifecycle.deleted_at IS NOT NULL
                    THEN EXCLUDED.disabled_at
                ELSE jellyfin_account_lifecycle.disabled_at
            END,
            delete_after=CASE
                WHEN jellyfin_account_lifecycle.restored_at IS NOT NULL OR jellyfin_account_lifecycle.deleted_at IS NOT NULL
                    THEN EXCLUDED.delete_after
                ELSE jellyfin_account_lifecycle.disabled_at + ($11::int * INTERVAL '1 day')
            END,
            deleted_at=NULL,
            restored_at=NULL,
            metadata=EXCLUDED.metadata,
            updated_at=NOW()
        RETURNING id,disabled_at,delete_after
    `, [
        row.account_id,row.customer_id,row.server_id,row.jellyfin_user_id,row.jellyfin_username,
        row.triggers.join('; '),deletion.source,now,deleteAfter,
        JSON.stringify({ ...evidence, deleteAfterDisableDays: deletion.days, deletePolicySource: deletion.source }),
        deletion.days
    ]);
    return ledger.rows[0];
}

async function pendingFreeLifecycle() {
    const result = await query(`
        SELECT lc.id lifecycle_id,lc.account_id,lc.customer_id,lc.server_id,lc.jellyfin_user_id,lc.jellyfin_username,
               lc.disabled_at,lc.delete_after,lc.metadata,
               ja.disabled,ja.last_activity_at,ja.access_lane,ja.account_purpose,
               c.automation_protected,
               fa.plan_id,fa.plan_code,fa.inactivity_policy,
               EXISTS(SELECT 1 FROM active_playback_sessions aps WHERE aps.customer_id=lc.customer_id AND aps.server_id=lc.server_id) currently_playing,
               EXISTS(SELECT 1 FROM customer_access_holds h WHERE h.customer_id=lc.customer_id AND h.hold_type=$1 AND h.source_key=('plan:'||fa.plan_id::text) AND h.released_at IS NULL) inactivity_held
        FROM jellyfin_account_lifecycle lc
        JOIN jellyfin_accounts ja ON ja.id=lc.account_id
        JOIN customers c ON c.id=lc.customer_id
        LEFT JOIN LATERAL (
            SELECT s.plan_id,p.code plan_code,p.inactivity_policy
            FROM subscriptions s JOIN plans p ON p.id=s.plan_id
            WHERE s.customer_id=lc.customer_id AND s.superseded_by IS NULL
              AND s.status IN('active','trialing','past_due','paused') AND s.starts_at<=NOW() AND s.current_period_end>NOW()
              AND p.is_free_tier=TRUE AND p.price_minor=0 AND COALESCE(p.service_type,'jellyfin') IN('jellyfin','bundle')
            ORDER BY s.created_at DESC LIMIT 1
        ) fa ON TRUE
        WHERE lc.category='free' AND lc.deleted_at IS NULL AND lc.restored_at IS NULL
          AND ja.account_purpose='jellyfin' AND ja.access_lane='free'
        ORDER BY lc.delete_after,lc.id
    `, [base.HOLD_TYPE]);
    return result.rows;
}

async function markLifecycleRestored(row, reason, actorUserId = null) {
    if (row.plan_id) {
        await accessHolds.releaseHold({ customerId: row.customer_id, type: base.HOLD_TYPE, sourceKey: `plan:${row.plan_id}`, actorUserId });
    }
    await query(`UPDATE jellyfin_account_lifecycle SET restored_at=NOW(),metadata=metadata||$2::jsonb,updated_at=NOW() WHERE id=$1`, [
        row.lifecycle_id, JSON.stringify({ restoredReason: reason })
    ]);
    await provisioning.reconcileCustomer(row.customer_id).catch(error => {
        console.warn('Free Server lifecycle restoration reconciliation pending:', { customerId: row.customer_id, error: error.message });
    });
}

function activityAfterDisable(row) {
    if (!row.last_activity_at || !row.disabled_at) return false;
    const activity = new Date(row.last_activity_at).getTime();
    const disabled = new Date(row.disabled_at).getTime();
    return Number.isFinite(activity) && Number.isFinite(disabled) && activity > disabled;
}

async function processPendingDeletions(globalCfg, { actorUserId = null, forceDryRun = null } = {}) {
    let rows = await pendingFreeLifecycle();
    if (!rows.length) return { processed: 0, deleted: 0, restored: 0, failed: 0, deferred: 0, serverFailures: 0 };

    const worker = await activityWorkerTelemetry();
    if (!worker.ready) {
        return { processed: rows.length, deleted: 0, restored: 0, failed: 0, deferred: rows.length, serverFailures: 0, skipped: 'telemetry_not_trustworthy', telemetry: telemetrySummary(worker, {}) };
    }

    let serverTelemetry = await refreshCandidateServers(rows, {});
    serverTelemetry = await refreshCandidateUserActivity(rows, serverTelemetry);
    rows = await pendingFreeLifecycle();
    let deleted = 0, restored = 0, failed = 0, deferred = 0;

    for (const row of rows) {
        try {
            const server = serverTelemetry[String(row.server_id)];
            if (!server?.ready) { deferred += 1; continue; }
            if (!row.plan_id || !row.inactivity_held || row.automation_protected || row.disabled !== true) {
                await markLifecycleRestored(row, !row.plan_id ? 'free_entitlement_changed' : row.automation_protected ? 'admin_protected' : row.disabled !== true ? 'account_reenabled' : 'inactivity_hold_released', actorUserId);
                restored += 1;
                continue;
            }
            if (row.currently_playing) { deferred += 1; continue; }
            if (activityAfterDisable(row)) {
                await markLifecycleRestored(row, 'activity_after_disable', actorUserId);
                restored += 1;
                continue;
            }

            const effective = planPolicy.effectiveForFreePlan(row.inactivity_policy || {}, globalCfg);
            if (!planPolicy.hasUsageTrigger(effective)) {
                await markLifecycleRestored(row, 'inactivity_policy_disabled', actorUserId);
                restored += 1;
                continue;
            }

            const deletion = deletionPolicy(globalCfg, row.inactivity_policy);
            const due = new Date(new Date(row.disabled_at).getTime() + deletion.days * 86400000);
            await query(`UPDATE jellyfin_account_lifecycle SET delete_after=$2,policy_source=$3,metadata=metadata||$4::jsonb,updated_at=NOW() WHERE id=$1`, [
                row.lifecycle_id,due,deletion.source,JSON.stringify({ deleteAfterDisableDays: deletion.days, deletePolicySource: deletion.source })
            ]);
            if (due.getTime() > Date.now()) { deferred += 1; continue; }

            const dryRun = forceDryRun === null ? effective.dryRun : Boolean(forceDryRun);
            const evidence = { category: 'free', accessLane: 'free', disabledAt: row.disabled_at, deleteAfter: due, planId: row.plan_id, planCode: row.plan_code, dryRun, portalAccountPreserved: true, activityPollTrustedImmediatelyBeforeDecision: true, activityRefreshedImmediatelyBeforeDecision: true };
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'jellyfin_account',$3,$4::jsonb)`, [actorUserId,dryRun?'jellyfin.lifecycle.would_delete':'jellyfin.lifecycle.delete',row.account_id,JSON.stringify(evidence)]);
            if (dryRun) { deferred += 1; continue; }

            try {
                await registry.request(row.server_id, `/Users/${encodeURIComponent(row.jellyfin_user_id)}`, { method: 'DELETE' });
            } catch (error) {
                const message = String(error?.message || error);
                if (!/\b404\b|not found/i.test(message)) throw error;
            }
            await transaction(async client => {
                await client.query(`UPDATE jellyfin_account_lifecycle SET account_id=NULL,deleted_at=NOW(),metadata=metadata||$2::jsonb,updated_at=NOW() WHERE id=$1`, [row.lifecycle_id, JSON.stringify({ remoteDeleteConfirmed: true })]);
                await client.query('DELETE FROM jellyfin_accounts WHERE id=$1', [row.account_id]);
            });
            deleted += 1;
        } catch (error) {
            failed += 1;
            console.error('Free Server lifecycle deletion failed:', { accountId: row.account_id, error: String(error?.message || error).slice(0, 500) });
        }
    }
    return { processed: rows.length, deleted, restored, failed, deferred, serverFailures: Object.values(serverTelemetry).filter(value => !value.ready).length, serverTelemetry, telemetry: telemetrySummary(worker, serverTelemetry) };
}

async function usageSatisfiedEarlierToday(row) {
    const minimumMinutes = Number(row?.policy?.minimumPlaybackMinutes);
    const windowDays = Number(row?.policy?.playbackWindowDays);
    if (!Number.isFinite(minimumMinutes) || minimumMinutes <= 0 || !Number.isFinite(windowDays) || windowDays <= 0) return false;
    const result = await query(`
        SELECT COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(ended_at,last_seen_at)-started_at)))),0)::bigint playback_seconds
        FROM playback_history
        WHERE customer_id=$1 AND server_id=$2
          AND started_at >= date_trunc('day',NOW()) - ($3::int * INTERVAL '1 day')
    `, [row.customer_id,row.server_id,windowDays]);
    return Number(result.rows[0]?.playback_seconds || 0) >= minimumMinutes * 60;
}

async function finalEligibility(row, globalCfg) {
    const worker = await activityWorkerTelemetry();
    if (!worker.ready) return { ready: false, reason: 'activity_worker_stale', worker, server: null };

    let serverTelemetry = await refreshCandidateServers([row]);
    let server = serverTelemetry[String(row.server_id)] || null;
    if (!server?.ready) return { ready: false, reason: server?.reason || 'server_poll_untrusted', worker, server };

    serverTelemetry = await refreshCandidateUserActivity([row], serverTelemetry);
    server = serverTelemetry[String(row.server_id)] || null;
    if (!server?.ready) return { ready: false, reason: server?.reason || 'user_activity_refresh_failed', worker, server };

    const freshRows = await base.candidates(globalCfg, { customerId: row.customer_id });
    const fresh = freshRows.find(item => String(item.account_id) === String(row.account_id) && String(item.plan_id) === String(row.plan_id)) || null;
    if (!fresh?.eligible) return { ready: false, reason: 'usage_no_longer_eligible', worker, server, fresh };
    if (await usageSatisfiedEarlierToday(fresh)) return { ready: false, reason: 'usage_satisfied_earlier_today', worker, server, fresh };
    return { ready: true, worker, server, fresh };
}

async function logTelemetrySkip(row, actorUserId, reason, server = null) {
    const metadata = {
        planId: row.plan_id,
        planCode: row.plan_code,
        accessLane: 'free',
        accountId: row.account_id,
        serverId: row.server_id,
        reason,
        serverTelemetry: server || null
    };
    console.warn('Free Server inactivity enforcement skipped:', metadata);
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'customer.inactivity.skipped_telemetry','customer',$2,$3::jsonb)`, [actorUserId,row.customer_id,JSON.stringify(metadata)]).catch(() => {});
}

async function runPlanRules({ actorUserId = null, forceDryRun = null } = {}) {
    const globalCfg = await lifecyclePolicy.get();
    const released = await base.releaseObsoletePlanHolds(actorUserId, globalCfg);
    if (!globalCfg.enabled) return { processed: 0, eligible: 0, enforced: 0, wouldDisable: 0, released, dryRun: true, skipped: 'lifecycle_disabled' };

    const worker = await activityWorkerTelemetry();
    if (!worker.ready) {
        return {
            processed: 0, eligible: 0, enforced: 0, wouldDisable: 0, failed: 1, released, dryRun: true,
            skipped: 'telemetry_not_trustworthy',
            warning: `Free Server inactivity checks are paused: activity worker heartbeat is ${worker.activityWorkerAgeSeconds == null ? 'missing' : `${worker.activityWorkerAgeSeconds}s old`}. No customer will be disabled for inactivity until it recovers.`,
            telemetry: telemetrySummary(worker, {})
        };
    }

    const discovered = await base.candidates(globalCfg);
    let serverTelemetry = await refreshCandidateServers(discovered);
    serverTelemetry = await refreshCandidateUserActivity(discovered, serverTelemetry);
    const rows = discovered.length ? await base.candidates(globalCfg) : discovered;
    serverTelemetry = await refreshCandidateServers(rows, serverTelemetry);
    const eligible = eligibleOnReadyServers(rows, serverTelemetry);
    const unsafeEligible = rows.filter(row => row?.eligible && !serverTelemetry[String(row.server_id)]?.ready);
    let enforced = 0, wouldDisable = 0, failed = 0, safetySkipped = unsafeEligible.length;

    for (const row of unsafeEligible) {
        const server = serverTelemetry[String(row.server_id)] || null;
        await logTelemetrySkip(row, actorUserId, server?.reason || 'server_poll_untrusted', server);
    }

    for (const original of eligible) {
        const final = await finalEligibility(original, globalCfg);
        if (!final.ready) {
            safetySkipped += 1;
            await logTelemetrySkip(original, actorUserId, final.reason, final.server || null);
            continue;
        }
        const row = final.fresh;
        const dryRun = forceDryRun === null ? row.policy.dryRun : Boolean(forceDryRun);
        const evidence = { planId: row.plan_id, planCode: row.plan_code, accessLane: 'free', accountId: row.account_id, serverId: row.server_id, lastPlaybackAt: row.last_playback_at || null, inactiveReferenceAt: row.inactive_reference_at, observationStartedAt: row.observation_started_at, playbackMinutes: Math.round(row.playback_seconds / 60), triggers: row.triggers, dryRun, policyInherited: row.policy.inherited, repairExistingHold: Boolean(row.repairExistingHold), portalAccountPreserved: true, activityPollTrustedImmediatelyBeforeDecision: true, activityRefreshedImmediatelyBeforeDecision: true };
        try {
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'customer',$3,$4::jsonb)`, [actorUserId,dryRun?'customer.inactivity.would_disable_jellyfin':'customer.inactivity.disable_jellyfin',row.customer_id,JSON.stringify(evidence)]);
            if (dryRun) { wouldDisable += 1; continue; }
            await accessHolds.addHold({ customerId: row.customer_id, type: base.HOLD_TYPE, sourceKey: `plan:${row.plan_id}`, reason: `Free-plan Jellyfin usage rule: ${row.triggers.join('; ')}`, actorUserId, metadata: evidence });
            try {
                await provisioning.reconcileCustomer(row.customer_id);
                await recordDisabledLifecycle(row, evidence, globalCfg);
                enforced += 1;
            } catch (error) {
                await accessHolds.releaseHold({ customerId: row.customer_id, type: base.HOLD_TYPE, sourceKey: `plan:${row.plan_id}`, actorUserId }).catch(() => {});
                await provisioning.reconcileCustomer(row.customer_id).catch(recoveryError => {
                    console.warn('Free Server inactivity rollback reconciliation pending:', { customerId: row.customer_id, error: recoveryError.message });
                });
                throw error;
            }
        } catch (error) {
            failed += 1;
            console.error('Free Server inactivity enforcement failed:', { accountId: row.account_id, error: String(error?.message || error).slice(0, 500) });
        }
    }

    const telemetry = telemetrySummary(worker, serverTelemetry);
    return { processed: rows.length, eligible: eligible.length, enforced, wouldDisable, failed, safetySkipped, released, dryRun: eligible.every(row => forceDryRun === true || row.policy.dryRun), telemetry, serverFailures: telemetry.unsafeTargetServers, examples: eligible.slice(0,25).map(row=>({customerId:row.customer_id,name:row.customer_name,plan:row.plan_code,server:row.server_name,triggers:row.triggers,lastPlaybackAt:row.last_playback_at,playbackMinutes:Math.round(row.playback_seconds/60)})) };
}

async function run(options = {}) {
    const globalCfg = await lifecyclePolicy.get();
    const planRules = await runPlanRules(options);
    const deletions = await processPendingDeletions(globalCfg, options);
    return {
        processed: Number(planRules.processed || 0) + Number(deletions.processed || 0),
        failed: Number(planRules.failed || 0) + Number(deletions.failed || 0),
        warning: planRules.warning || deletions.warning || undefined,
        planRules,
        deletions
    };
}

module.exports = {
    activityWorkerTelemetry,
    candidateServerIds,
    refreshCandidateServers,
    refreshCandidateUserActivity,
    eligibleOnReadyServers,
    telemetrySummary,
    deletionPolicy,
    recordDisabledLifecycle,
    pendingFreeLifecycle,
    activityAfterDisable,
    processPendingDeletions,
    usageSatisfiedEarlierToday,
    finalEligibility,
    runPlanRules,
    run,
    base
};
