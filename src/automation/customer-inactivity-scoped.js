'use strict';

const { query } = require('../db');
const accessHolds = require('../entitlements/access-holds');
const lifecyclePolicy = require('../entitlements/jellyfin-lifecycle-policy');
const subscriptionState = require('../entitlements/subscription-state');
const resilientProvisioning = require('../jellyfin/resilient-provisioning');
const provisioningHelpers = require('../jellyfin/provisioning-helpers');
const activityTrust = require('../jellyfin/activity-trust');
const fleetMetrics = require('../jellyfin/fleet-metrics');
const base = require('./customer-inactivity');

function intEnv(name, fallback, min, max) {
    const value = Number.parseInt(process.env[name] || '', 10);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
}

// This is throughput only. It never turns a valid removal set into a dry-run.
// If more users are eligible they are simply handled on the next scheduled run.
const MAX_ENFORCEMENTS_PER_RUN = intEnv('INACTIVITY_MAX_ENFORCEMENTS_PER_RUN', 100, 1, 500);

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

// Compatibility export for older callers/tests. Percentage/absolute mass-removal
// circuit breakers are retired: trustworthy playback evidence is the policy.
function massRemovalRisk(rows, eligible) {
    const population = Math.max(0, Number(rows?.length || 0));
    const eligibleCount = Math.max(0, Number(eligible?.length || 0));
    return {
        tripped: false,
        retired: true,
        population,
        eligible: eligibleCount,
        ratio: population > 0 ? eligibleCount / population : 0
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
    return (rows || []).filter(row => {
        if (!row?.eligible) return false;
        const server = serverTelemetry?.[String(row.server_id)];
        return Boolean(server?.ready && candidateUserEvidence(server, row)?.present);
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

// Compatibility helpers retained for callers that still import the old two-step
// disable/delete lifecycle. Free Server inactivity now deletes immediately.
function deletionPolicy() {
    return { days: 0, source: 'activity_policy' };
}
async function recordDisabledLifecycle() { return null; }
async function pendingFreeLifecycle() { return []; }
function activityAfterDisable() { return false; }
async function processPendingDeletions() {
    return { processed: 0, deleted: 0, restored: 0, failed: 0, deferred: 0, serverFailures: 0 };
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

async function finalEligibility(original, globalCfg, serverTelemetry) {
    // One fresh database read immediately before deletion. This is the only
    // policy re-check: if playback arrived since discovery, the user stays.
    const freshRows = await base.candidates(globalCfg, { customerId: original.customer_id });
    const fresh = freshRows.find(item =>
        String(item.account_id) === String(original.account_id)
        && String(item.plan_id) === String(original.plan_id)
    ) || null;
    if (!fresh?.eligible) {
        return { ready: false, reason: 'usage_no_longer_eligible', fresh };
    }

    // One entitlement/authority check prevents the inactivity worker racing an
    // admin pin, permanent-access change or replacement subscription.
    const entitlement = await subscriptionState.liveFreeJellyfinSubscription(fresh.customer_id, { includeBlocked: true });
    if (!entitlement || String(entitlement.plan_id || '') !== String(fresh.plan_id || '')) {
        return { ready: false, reason: 'free_entitlement_changed', fresh, entitlement };
    }
    if (entitlement.blocked && !fresh.repairExistingHold) {
        return { ready: false, reason: 'free_entitlement_blocked', fresh, entitlement };
    }
    if (adminProtectedFreeEntitlement(entitlement)) {
        return { ready: false, reason: 'admin_authority_protects_free_access', fresh, entitlement };
    }

    const server = serverTelemetry?.[String(fresh.server_id)] || null;
    const userEvidence = candidateUserEvidence(server, fresh);
    if (!server?.ready || !userEvidence?.present) {
        return {
            ready: false,
            reason: !server?.ready ? (server?.reason || 'server_poll_untrusted') : 'candidate_user_not_observed_in_fresh_users_response',
            fresh,
            entitlement,
            server,
            userEvidence
        };
    }

    return { ready: true, fresh, entitlement, server, userEvidence };
}

async function logSafetySkip(row, actorUserId, reason, server = null) {
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
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'customer.inactivity.skipped_safety','customer',$2,$3::jsonb)`, [
        actorUserId,row.customer_id,JSON.stringify(metadata)
    ]).catch(() => {});
}

async function verifyRemoved(accountId) {
    const result = await query('SELECT 1 FROM jellyfin_accounts WHERE id=$1', [accountId]);
    if (result.rowCount) {
        const error = new Error('Free Server inactivity deletion did not remove the Jellyfin account.');
        error.code = 'FREE_JELLYFIN_REMOVAL_POSTCONDITION_FAILED';
        throw error;
    }
}

async function removeFreeAccount(row, actorUserId, evidence) {
    const sourceKey = `plan:${row.plan_id}`;
    await accessHolds.addHold({
        customerId: row.customer_id,
        type: base.HOLD_TYPE,
        sourceKey,
        reason: `Free Server usage rule: ${row.triggers.join('; ')}`,
        actorUserId,
        metadata: evidence
    });

    try {
        await provisioningHelpers.deleteJellyfinAccount({
            ...row,
            id: row.account_id,
            access_lane: 'free'
        }, {
            reason: `Free Server inactivity: ${row.triggers.join('; ')}`,
            actorUserId
        });
        await verifyRemoved(row.account_id);
    } catch (error) {
        // A failed delete must not strand a customer behind an inactivity hold.
        await accessHolds.releaseHold({ customerId: row.customer_id, type: base.HOLD_TYPE, sourceKey, actorUserId }).catch(() => {});
        await resilientProvisioning.reconcileCustomer(row.customer_id).catch(recoveryError => {
            console.warn('Free Server inactivity rollback reconciliation pending:', {
                customerId: row.customer_id,
                error: recoveryError.message
            });
        });
        throw error;
    }

    // The hold is intentionally retained so ordinary reconciliation cannot
    // recreate the account. Explicit re-add creates a new allocation and the
    // stale hold is released by the allocation reset logic.
    await resilientProvisioning.reconcileCustomer(row.customer_id).catch(error => {
        console.warn('Free Server post-removal reconciliation pending:', {
            customerId: row.customer_id,
            error: error.message
        });
    });
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
            warning: globalCfg.configurationMissing
                ? 'Free Server inactivity enforcement is paused because the lifecycle settings row is missing. Save the lifecycle configuration explicitly before enabling enforcement.'
                : undefined
        };
    }

    // This is the destructive safety boundary we keep: if activity collection is
    // stale, nobody is removed because we do not know whether they played.
    const worker = await activityWorkerTelemetry();
    if (!worker.ready) {
        return {
            processed: 0, eligible: 0, enforced: 0, wouldRemove: 0, failed: 1, released, dryRun: true,
            skipped: 'telemetry_not_trustworthy',
            warning: `Free Server inactivity checks are paused: activity worker heartbeat is ${worker.activityWorkerAgeSeconds == null ? 'missing' : `${worker.activityWorkerAgeSeconds}s old`}. No customer will be removed until playback telemetry recovers.`,
            telemetry: telemetrySummary(worker, {})
        };
    }

    const rows = await base.candidates(globalCfg);
    let serverTelemetry = await refreshCandidateServers(rows);
    serverTelemetry = await refreshCandidateUserActivity(rows, serverTelemetry);

    const readyEligible = eligibleOnReadyServers(rows, serverTelemetry);
    const unsafeEligible = rows.filter(row => row?.eligible && !readyEligible.includes(row));
    const selected = readyEligible.slice(0, MAX_ENFORCEMENTS_PER_RUN);
    const deferred = Math.max(0, readyEligible.length - selected.length);
    let enforced = 0;
    let wouldRemove = 0;
    let failed = 0;
    let safetySkipped = unsafeEligible.length;

    for (const row of unsafeEligible) {
        const server = serverTelemetry[String(row.server_id)] || null;
        const reason = !server?.ready
            ? (server?.reason || 'server_poll_untrusted')
            : 'candidate_user_not_observed_in_fresh_users_response';
        await logSafetySkip(row, actorUserId, reason, server);
    }

    for (const original of selected) {
        const final = await finalEligibility(original, globalCfg, serverTelemetry);
        if (!final.ready) {
            safetySkipped += 1;
            await logSafetySkip(original, actorUserId, final.reason, final.server || null);
            continue;
        }

        const row = final.fresh;
        const dryRun = forceDryRun === null ? Boolean(row.policy.dryRun) : Boolean(forceDryRun);
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
            rollingPlaybackMinutes: Math.round(Number(row.playback_seconds || 0) / 60),
            triggers: row.triggers,
            dryRun,
            policyInherited: row.policy.inherited,
            repairExistingHold: Boolean(row.repairExistingHold),
            portalAccountPreserved: true,
            activityPollTrustedBeforeDecision: true,
            activityObservedForCandidate: Boolean(final.userEvidence?.present),
            lifecycle: 'present_or_deleted'
        };

        try {
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'customer',$3,$4::jsonb)`, [
                actorUserId,
                dryRun ? 'customer.inactivity.would_remove_jellyfin' : 'customer.inactivity.remove_jellyfin',
                row.customer_id,
                JSON.stringify(evidence)
            ]);
            if (dryRun) {
                wouldRemove += 1;
                continue;
            }

            await removeFreeAccount(row, actorUserId, evidence);
            enforced += 1;
        } catch (error) {
            failed += 1;
            console.error('Free Server inactivity removal failed:', {
                accountId: row.account_id,
                error: String(error?.message || error).slice(0, 500)
            });
        }
    }

    const telemetry = telemetrySummary(worker, serverTelemetry);
    const warning = deferred
        ? `${deferred} eligible Free Server removal${deferred === 1 ? '' : 's'} deferred by the ${MAX_ENFORCEMENTS_PER_RUN}-customer throughput cap; they will be removed on the next run if still inactive.`
        : undefined;

    return {
        processed: rows.length,
        eligible: readyEligible.length,
        enforced,
        wouldRemove,
        wouldDisable: wouldRemove,
        failed,
        deferred,
        safetySkipped,
        released,
        warning,
        circuitBreaker: massRemovalRisk(rows, readyEligible),
        dryRun: Boolean(selected.length && selected.every(row => forceDryRun === true || row.policy.dryRun)),
        telemetry,
        serverFailures: telemetry.unsafeTargetServers,
        examples: readyEligible.slice(0,25).map(row => ({
            customerId: row.customer_id,
            name: row.customer_name,
            plan: row.plan_code,
            server: row.server_name,
            triggers: row.triggers,
            allocationStartAt: row.allocation_start_at,
            lastPlaybackAt: row.last_playback_at,
            playbackMinutes: Math.round(Number(row.playback_seconds || 0) / 60)
        }))
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
    adminProtectedFreeEntitlement,
    finalEligibility,
    logSafetySkip,
    verifyRemoved,
    removeFreeAccount,
    runPlanRules,
    run,
    base
};
