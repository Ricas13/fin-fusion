'use strict';

const { query } = require('../db');
const accessHolds = require('../entitlements/access-holds');
const lifecyclePolicy = require('../entitlements/jellyfin-lifecycle-policy');
const restorationGrace = require('../entitlements/jellyfin-inactivity-grace');
const provisioning = require('../jellyfin/resilient-provisioning');
const activityTrust = require('../jellyfin/activity-trust');
const fleetMetrics = require('../jellyfin/fleet-metrics');
const base = require('./customer-inactivity');

async function activityWorkerTelemetry() {
    return activityTrust.workerTelemetry();
}

function candidateServerIds(rows) {
    return [...new Set((rows || [])
        .map(row => row?.server_id == null ? null : String(row.server_id))
        .filter(Boolean))];
}

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
    return (rows || []).filter(row => row?.eligible && serverTelemetry?.[String(row.server_id)]?.ready);
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

// Kept as a compatibility export for callers/tests that still import it. There
// is no longer a post-disable deletion window: the activity policy itself is
// the grace period. Once it is breached the Free Server account is removed.
function deletionPolicy() {
    return { days: 0, source: 'activity_policy' };
}

async function recordDisabledLifecycle() {
    return null;
}

async function pendingFreeLifecycle() {
    return [];
}

function activityAfterDisable() {
    return false;
}

async function processPendingDeletions() {
    return { processed: 0, deleted: 0, restored: 0, failed: 0, deferred: 0, serverFailures: 0 };
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

    const freshRows = await restorationGrace.applyRestorationGrace(await base.candidates(globalCfg, { customerId: row.customer_id }));
    const fresh = freshRows.find(item => String(item.account_id) === String(row.account_id) && String(item.plan_id) === String(row.plan_id)) || null;
    if (!fresh?.eligible) return { ready: false, reason: fresh?.restoration_grace ? 'admin_restore_observation_window' : 'usage_no_longer_eligible', worker, server, fresh };
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

async function verifyRemoved(accountId) {
    const result = await query('SELECT 1 FROM jellyfin_accounts WHERE id=$1', [accountId]);
    if (result.rowCount) {
        const error = new Error('Free Server inactivity reconciliation did not remove the Jellyfin account.');
        error.code = 'FREE_JELLYFIN_REMOVAL_POSTCONDITION_FAILED';
        throw error;
    }
}

async function runPlanRules({ actorUserId = null, forceDryRun = null } = {}) {
    const globalCfg = await lifecyclePolicy.get();
    const released = await base.releaseObsoletePlanHolds(actorUserId, globalCfg);
    if (!globalCfg.enabled) return { processed: 0, eligible: 0, enforced: 0, wouldRemove: 0, released, dryRun: true, skipped: 'lifecycle_disabled' };

    const worker = await activityWorkerTelemetry();
    if (!worker.ready) {
        return {
            processed: 0, eligible: 0, enforced: 0, wouldRemove: 0, failed: 1, released, dryRun: true,
            skipped: 'telemetry_not_trustworthy',
            warning: `Free Server inactivity checks are paused: activity worker heartbeat is ${worker.activityWorkerAgeSeconds == null ? 'missing' : `${worker.activityWorkerAgeSeconds}s old`}. No customer will be removed for inactivity until it recovers.`,
            telemetry: telemetrySummary(worker, {})
        };
    }

    const discovered = await restorationGrace.applyRestorationGrace(await base.candidates(globalCfg));
    let serverTelemetry = await refreshCandidateServers(discovered);
    serverTelemetry = await refreshCandidateUserActivity(discovered, serverTelemetry);
    const rows = discovered.length ? await restorationGrace.applyRestorationGrace(await base.candidates(globalCfg)) : discovered;
    serverTelemetry = await refreshCandidateServers(rows, serverTelemetry);
    const eligible = eligibleOnReadyServers(rows, serverTelemetry);
    const unsafeEligible = rows.filter(row => row?.eligible && !serverTelemetry[String(row.server_id)]?.ready);
    let enforced = 0, wouldRemove = 0, failed = 0, safetySkipped = unsafeEligible.length;

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
        const evidence = {
            planId: row.plan_id,
            planCode: row.plan_code,
            accessLane: 'free',
            accountId: row.account_id,
            serverId: row.server_id,
            lastPlaybackAt: row.last_playback_at || null,
            inactiveReferenceAt: row.inactive_reference_at,
            observationStartedAt: row.observation_started_at,
            playbackMinutes: Math.round(row.playback_seconds / 60),
            triggers: row.triggers,
            dryRun,
            policyInherited: row.policy.inherited,
            repairExistingHold: Boolean(row.repairExistingHold),
            portalAccountPreserved: true,
            activityPollTrustedImmediatelyBeforeDecision: true,
            activityRefreshedImmediatelyBeforeDecision: true,
            lifecycle: 'present_or_deleted'
        };
        try {
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'customer',$3,$4::jsonb)`, [
                actorUserId,
                dryRun ? 'customer.inactivity.would_remove_jellyfin' : 'customer.inactivity.remove_jellyfin',
                row.customer_id,
                JSON.stringify(evidence)
            ]);
            if (dryRun) { wouldRemove += 1; continue; }

            await accessHolds.addHold({
                customerId: row.customer_id,
                type: base.HOLD_TYPE,
                sourceKey: `plan:${row.plan_id}`,
                reason: `Free-plan Jellyfin usage rule: ${row.triggers.join('; ')}`,
                actorUserId,
                metadata: evidence
            });
            try {
                await provisioning.reconcileCustomer(row.customer_id);
                await verifyRemoved(row.account_id);
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
            console.error('Free Server inactivity removal failed:', { accountId: row.account_id, error: String(error?.message || error).slice(0, 500) });
        }
    }

    const telemetry = telemetrySummary(worker, serverTelemetry);
    return {
        processed: rows.length,
        eligible: eligible.length,
        enforced,
        wouldRemove,
        // Compatibility key for older job dashboards; no disable action exists.
        wouldDisable: wouldRemove,
        failed,
        safetySkipped,
        released,
        dryRun: eligible.every(row => forceDryRun === true || row.policy.dryRun),
        telemetry,
        serverFailures: telemetry.unsafeTargetServers,
        examples: eligible.slice(0,25).map(row=>({customerId:row.customer_id,name:row.customer_name,plan:row.plan_code,server:row.server_name,triggers:row.triggers,lastPlaybackAt:row.last_playback_at,playbackMinutes:Math.round(row.playback_seconds/60)}))
    };
}

async function run(options = {}) {
    const planRules = await runPlanRules(options);
    return {
        processed: Number(planRules.processed || 0),
        failed: Number(planRules.failed || 0),
        warning: planRules.warning || undefined,
        planRules,
        deletions: await processPendingDeletions()
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