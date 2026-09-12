'use strict';

const { query } = require('../db');
const accessHolds = require('../entitlements/access-holds');
const lifecyclePolicy = require('../entitlements/jellyfin-lifecycle-policy');
const restorationGrace = require('../entitlements/jellyfin-inactivity-grace');
const subscriptionState = require('../entitlements/subscription-state');
const provisioning = require('../jellyfin/resilient-provisioning');
const activityTrust = require('../jellyfin/activity-trust');
const fleetMetrics = require('../jellyfin/fleet-metrics');
const base = require('./customer-inactivity');

function intEnv(name, fallback, min, max) {
    const value = Number.parseInt(process.env[name] || '', 10);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
}

function floatEnv(name, fallback, min, max) {
    const value = Number.parseFloat(process.env[name] || '');
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
}

const MAX_ENFORCEMENTS_PER_RUN = intEnv('INACTIVITY_MAX_ENFORCEMENTS_PER_RUN', 20, 1, 500);
const CIRCUIT_BREAKER_MIN_ELIGIBLE = intEnv('INACTIVITY_CIRCUIT_BREAKER_MIN_ELIGIBLE', 5, 2, 500);
const CIRCUIT_BREAKER_MAX_ABSOLUTE = intEnv('INACTIVITY_CIRCUIT_BREAKER_MAX_ABSOLUTE', 20, 2, 500);
const CIRCUIT_BREAKER_MAX_RATIO = floatEnv('INACTIVITY_CIRCUIT_BREAKER_MAX_RATIO', 0.15, 0.01, 1);

async function activityWorkerTelemetry() {
    return activityTrust.workerTelemetry();
}

function candidateServerIds(rows) {
    return [...new Set((rows || [])
        .map(row => row?.server_id == null ? null : String(row.server_id))
        .filter(Boolean))];
}

function expectedUserIdsForServer(rows, serverId) {
    return [...new Set((rows || [])
        .filter(row => String(row?.server_id || '') === String(serverId))
        .map(row => row?.jellyfin_user_id == null ? null : String(row.jellyfin_user_id))
        .filter(Boolean))];
}

function candidateUserEvidence(server, row) {
    const id = row?.jellyfin_user_id == null ? '' : String(row.jellyfin_user_id).toLowerCase();
    return id ? server?.userActivity?.expectedUsers?.[id] || null : null;
}

function massRemovalRisk(rows, eligible) {
    const population = Math.max(0, Number(rows?.length || 0));
    const eligibleCount = Math.max(0, Number(eligible?.length || 0));
    const ratio = population > 0 ? eligibleCount / population : 0;
    // Thresholds are inclusive. If the operator says 20 is the maximum safe
    // batch, the 20th simultaneous candidate is already suspicious and must
    // force dry-run; do not allow an off-by-one batch of exactly 20 deletions.
    const tripped = eligibleCount >= CIRCUIT_BREAKER_MIN_ELIGIBLE
        && (eligibleCount >= CIRCUIT_BREAKER_MAX_ABSOLUTE || ratio >= CIRCUIT_BREAKER_MAX_RATIO);
    return {
        tripped,
        population,
        eligible: eligibleCount,
        ratio,
        maxAbsolute: CIRCUIT_BREAKER_MAX_ABSOLUTE,
        maxRatio: CIRCUIT_BREAKER_MAX_RATIO,
        minEligible: CIRCUIT_BREAKER_MIN_ELIGIBLE
    };
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
            const refreshed = await fleetMetrics.refreshServerUserActivity(serverId, {
                expectedUserIds: expectedUserIdsForServer(rows, serverId)
            });
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
          AND ($4::timestamptz IS NULL OR started_at >= $4::timestamptz)
    `, [row.customer_id,row.server_id,windowDays,row.allocation_start_at || null]);
    return Number(result.rows[0]?.playback_seconds || 0) >= minimumMinutes * 60;
}

function adminProtectedFreeEntitlement(entitlement) {
    if (!entitlement) return false;
    const mode = String(entitlement.admin_jellyfin_mode || '').toLowerCase();
    return Boolean(
        entitlement.permanent_access
        || entitlement.admin_present
        || mode === 'present'
        || mode === 'forced_server'
    );
}

async function finalEligibility(row, globalCfg) {
    // Destructive policy enforcement gets an independent entitlement/authority
    // check immediately before telemetry and usage checks. The base candidate
    // query deliberately focuses on usage; this second source of truth prevents
    // an explicit admin-present/server-pin/permanent directive, a newly-added
    // hold, or a plan replacement from being raced by the inactivity worker.
    const entitlement = await subscriptionState.liveFreeJellyfinSubscription(row.customer_id, { includeBlocked: true });
    if (!entitlement) return { ready: false, reason: 'free_entitlement_no_longer_active', entitlement };
    if (String(entitlement.plan_id || '') !== String(row.plan_id || '')) {
        return { ready: false, reason: 'free_entitlement_changed', entitlement };
    }
    // A previously-created inactivity hold is allowed through so this worker can
    // repair a prior reconciliation failure. Other blocked states fail closed.
    // Admin-present/server-pin/permanent authority is checked independently below
    // and therefore can never be bypassed by this repair exception.
    if (entitlement.blocked && !row.repairExistingHold) {
        return { ready: false, reason: 'free_entitlement_blocked', entitlement };
    }
    if (adminProtectedFreeEntitlement(entitlement)) {
        return { ready: false, reason: 'admin_authority_protects_free_access', entitlement };
    }

    const worker = await activityWorkerTelemetry();
    if (!worker.ready) return { ready: false, reason: 'activity_worker_stale', worker, server: null, entitlement };

    let serverTelemetry = await refreshCandidateServers([row]);
    let server = serverTelemetry[String(row.server_id)] || null;
    if (!server?.ready) return { ready: false, reason: server?.reason || 'server_poll_untrusted', worker, server, entitlement };

    serverTelemetry = await refreshCandidateUserActivity([row], serverTelemetry);
    server = serverTelemetry[String(row.server_id)] || null;
    if (!server?.ready) return { ready: false, reason: server?.reason || 'user_activity_refresh_failed', worker, server, entitlement };

    const userEvidence = candidateUserEvidence(server, row);
    if (!userEvidence?.present) {
        return { ready: false, reason: 'candidate_user_not_observed_in_fresh_users_response', worker, server, userEvidence, entitlement };
    }

    const freshRows = await restorationGrace.applyRestorationGrace(await base.candidates(globalCfg, { customerId: row.customer_id }));
    const fresh = freshRows.find(item => String(item.account_id) === String(row.account_id) && String(item.plan_id) === String(row.plan_id)) || null;
    if (!fresh?.eligible) return { ready: false, reason: fresh?.restoration_grace ? 'admin_restore_observation_window' : 'usage_no_longer_eligible', worker, server, fresh, userEvidence, entitlement };
    if (await usageSatisfiedEarlierToday(fresh)) return { ready: false, reason: 'usage_satisfied_earlier_today', worker, server, fresh, userEvidence, entitlement };

    // Re-read authority one final time after remote telemetry/usage I/O. This is
    // intentionally redundant: those calls can take long enough for an admin or
    // billing workflow to change the customer's desired state. The subsequent
    // reconciliation lock still provides the final serialization boundary.
    const finalEntitlement = await subscriptionState.liveFreeJellyfinSubscription(row.customer_id, { includeBlocked: true });
    if (!finalEntitlement || String(finalEntitlement.plan_id || '') !== String(row.plan_id || '')) {
        return { ready: false, reason: 'free_entitlement_changed_during_check', worker, server, fresh, userEvidence, entitlement: finalEntitlement };
    }
    if (finalEntitlement.blocked && !fresh.repairExistingHold) {
        return { ready: false, reason: 'free_entitlement_blocked_during_check', worker, server, fresh, userEvidence, entitlement: finalEntitlement };
    }
    if (adminProtectedFreeEntitlement(finalEntitlement)) {
        return { ready: false, reason: 'admin_authority_added_during_check', worker, server, fresh, userEvidence, entitlement: finalEntitlement };
    }
    return { ready: true, worker, server, fresh, userEvidence, entitlement: finalEntitlement };
}

async function logTelemetrySkip(row, actorUserId, reason, server = null) {
    const metadata = {
        planId: row.plan_id,
        planCode: row.plan_code,
        accessLane: 'free',
        accountId: row.account_id,
        serverId: row.server_id,
        jellyfinUserId: row.jellyfin_user_id || null,
        reason,
        candidateUserEvidence: candidateUserEvidence(server, row),
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
    if (!globalCfg.enabled) {
        return {
            processed: 0,
            eligible: 0,
            enforced: 0,
            wouldRemove: 0,
            released,
            dryRun: true,
            skipped: globalCfg.configurationMissing ? 'lifecycle_configuration_missing' : 'lifecycle_disabled',
            warning: globalCfg.configurationMissing ? 'Free Server inactivity enforcement is paused because the lifecycle settings row is missing. Save the lifecycle configuration explicitly before enabling enforcement.' : undefined
        };
    }

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
    const selectedEligible = eligible.slice(0, MAX_ENFORCEMENTS_PER_RUN);
    const deferred = Math.max(0, eligible.length - selectedEligible.length);
    const circuitBreaker = massRemovalRisk(rows, eligible);
    let enforced = 0, wouldRemove = 0, failed = 0, safetySkipped = unsafeEligible.length;

    for (const row of unsafeEligible) {
        const server = serverTelemetry[String(row.server_id)] || null;
        await logTelemetrySkip(row, actorUserId, server?.reason || 'server_poll_untrusted', server);
    }

    for (const original of selectedEligible) {
        const final = await finalEligibility(original, globalCfg);
        if (!final.ready) {
            safetySkipped += 1;
            await logTelemetrySkip(original, actorUserId, final.reason, final.server || null);
            continue;
        }
        const row = final.fresh;
        const configuredDryRun = forceDryRun === null ? row.policy.dryRun : Boolean(forceDryRun);
        const dryRun = Boolean(configuredDryRun || circuitBreaker.tripped);
        const evidence = {
            planId: row.plan_id,
            planCode: row.plan_code,
            accessLane: 'free',
            accountId: row.account_id,
            serverId: row.server_id,
            jellyfinUserId: row.jellyfin_user_id || null,
            allocationStartAt: row.allocation_start_at || null,
            firstPlaybackAt: row.first_playback_at || null,
            lastPlaybackAt: row.last_playback_at || null,
            inactiveReferenceAt: row.inactive_reference_at,
            observationStartedAt: row.observation_started_at,
            playbackMinutes: Math.round(row.playback_seconds / 60),
            triggers: row.triggers,
            dryRun,
            safetyDryRun: circuitBreaker.tripped,
            circuitBreaker,
            policyInherited: row.policy.inherited,
            repairExistingHold: Boolean(row.repairExistingHold),
            portalAccountPreserved: true,
            activityPollTrustedImmediatelyBeforeDecision: true,
            activityRefreshedImmediatelyBeforeDecision: true,
            activityObservedForCandidate: Boolean(final.userEvidence?.present),
            jellyfinLastActivityDate: final.userEvidence?.lastActivityDate || null,
            jellyfinLastLoginDate: final.userEvidence?.lastLoginDate || null,
            jellyfinActivityAt: final.userEvidence?.activityAt || null,
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
    const warnings = [];
    if (circuitBreaker.tripped) {
        warnings.push(`Mass-removal circuit breaker forced dry-run: ${circuitBreaker.eligible}/${circuitBreaker.population} (${(circuitBreaker.ratio * 100).toFixed(1)}%) candidates were eligible; live removal is blocked at ${circuitBreaker.maxAbsolute} accounts or ${(circuitBreaker.maxRatio * 100).toFixed(1)}% once at least ${circuitBreaker.minEligible} accounts are eligible.`);
    }
    if (deferred) warnings.push(`${deferred} eligible inactivity removal${deferred === 1 ? '' : 's'} deferred by the ${MAX_ENFORCEMENTS_PER_RUN}-customer throughput cap; they will be reconsidered on the next run.`);
    const warning = warnings.length ? warnings.join(' ') : undefined;
    return {
        processed: rows.length,
        eligible: eligible.length,
        enforced,
        wouldRemove,
        wouldDisable: wouldRemove,
        failed,
        deferred,
        safetySkipped,
        released,
        warning,
        circuitBreaker,
        dryRun: Boolean(circuitBreaker.tripped || selectedEligible.every(row => forceDryRun === true || row.policy.dryRun)),
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
    MAX_ENFORCEMENTS_PER_RUN,
    CIRCUIT_BREAKER_MIN_ELIGIBLE,
    CIRCUIT_BREAKER_MAX_ABSOLUTE,
    CIRCUIT_BREAKER_MAX_RATIO,
    activityWorkerTelemetry,
    candidateServerIds,
    expectedUserIdsForServer,
    candidateUserEvidence,
    massRemovalRisk,
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
    adminProtectedFreeEntitlement,
    finalEligibility,
    runPlanRules,
    run,
    base
};