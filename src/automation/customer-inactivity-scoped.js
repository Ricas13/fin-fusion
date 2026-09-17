'use strict';

const { query } = require('../db');
const accessHolds = require('../entitlements/access-holds');
const lifecyclePolicy = require('../entitlements/jellyfin-lifecycle-policy');
const legacyGrace = require('../entitlements/jellyfin-inactivity-grace');
const subscriptionState = require('../entitlements/subscription-state');
const provisioning = require('../jellyfin/resilient-provisioning');
const activityTrust = require('../jellyfin/activity-trust');
const base = require('./customer-inactivity');

function intEnv(name, fallback, min, max) {
    const value = Number.parseInt(process.env[name] || '', 10);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
}

// Throughput protection only. This is not an eligibility rule.
const MAX_ENFORCEMENTS_PER_RUN = intEnv('INACTIVITY_MAX_ENFORCEMENTS_PER_RUN', 100, 1, 500);

async function activityWorkerTelemetry() {
    return activityTrust.workerTelemetry();
}

function candidateServerIds(rows) {
    return [...new Set((rows || [])
        .map(row => row?.server_id == null ? null : String(row.server_id))
        .filter(Boolean))];
}

async function refreshCandidateServers(rows) {
    return activityTrust.serverTelemetry(candidateServerIds(rows));
}

function eligibleOnReadyServers(rows, serverTelemetry) {
    return (rows || []).filter(
        row => row?.eligible && serverTelemetry?.[String(row.server_id)]?.ready
    );
}

function telemetrySummary(worker, serverTelemetry) {
    const servers = Object.entries(serverTelemetry || {}).map(
        ([serverId, value]) => ({ serverId, ...value })
    );
    const unsafe = servers.filter(server => !server.ready);
    return {
        ready: Boolean(worker?.ready && unsafe.length === 0),
        activityWorkerAgeSeconds: worker?.activityWorkerAgeSeconds ?? null,
        targetServers: servers.length,
        unsafeTargetServers: unsafe.length,
        servers
    };
}

function adminProtectedFreeEntitlement(entitlement) {
    if (!entitlement) return false;
    const mode = String(entitlement.admin_jellyfin_mode || '').toLowerCase();
    return Boolean(
        entitlement.permanent_access
        || entitlement.admin_present
        || mode === 'present'
    );
}

async function finalEligibility(row, globalCfg) {
    const worker = await activityWorkerTelemetry();
    if (!worker.ready) {
        return { ready: false, reason: 'activity_worker_stale', worker };
    }

    const freshRows = await legacyGrace.applyLegacySafetyWindow(
        await base.candidates(globalCfg, { customerId: row.customer_id })
    );
    const fresh = freshRows.find(item =>
        String(item.account_id) === String(row.account_id)
        && String(item.plan_id) === String(row.plan_id)
    ) || null;

    if (!fresh?.eligible) {
        return {
            ready: false,
            reason: fresh?.restoration_grace
                ? 'legacy_lane_observation_window'
                : 'usage_no_longer_eligible',
            worker,
            fresh
        };
    }

    const serverTelemetry = await activityTrust.serverTelemetry([fresh.server_id]);
    const server = serverTelemetry[String(fresh.server_id)] || null;
    if (!server?.ready) {
        return {
            ready: false,
            reason: server?.reason || 'server_poll_untrusted',
            worker,
            server,
            fresh
        };
    }

    const entitlement = await subscriptionState.liveFreeJellyfinSubscription(
        fresh.customer_id,
        { includeBlocked: true }
    );
    if (!entitlement) {
        return { ready: false, reason: 'free_entitlement_no_longer_active', worker, server, fresh };
    }
    if (String(entitlement.plan_id || '') !== String(fresh.plan_id || '')) {
        return { ready: false, reason: 'free_entitlement_changed', worker, server, fresh, entitlement };
    }
    if (entitlement.admin_jellyfin_removed) {
        return { ready: false, reason: 'admin_already_removed_access', worker, server, fresh, entitlement };
    }
    if (adminProtectedFreeEntitlement(entitlement)) {
        return { ready: false, reason: 'admin_authority_protects_free_access', worker, server, fresh, entitlement };
    }

    // The exact inactivity hold created by a prior failed attempt is allowed so
    // the next run can retry. Any other blocking state fails closed.
    if (entitlement.blocked && !fresh.repairExistingHold) {
        return { ready: false, reason: 'free_entitlement_blocked', worker, server, fresh, entitlement };
    }

    return { ready: true, worker, server, fresh, entitlement };
}

async function logSkip(row, actorUserId, reason, server = null) {
    await query(
        `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES($1,'customer.inactivity.skipped','customer',$2,$3::jsonb)`,
        [
            actorUserId,
            row.customer_id,
            JSON.stringify({
                planId: row.plan_id,
                accountId: row.account_id,
                serverId: row.server_id,
                reason,
                serverTelemetry: server || null
            })
        ]
    ).catch(() => {});
}

async function verifyRemoved(accountId) {
    const result = await query('SELECT 1 FROM jellyfin_accounts WHERE id=$1', [accountId]);
    if (result.rowCount) {
        const error = new Error('Free Server inactivity deletion did not remove the Jellyfin account.');
        error.code = 'FREE_JELLYFIN_REMOVAL_POSTCONDITION_FAILED';
        throw error;
    }
}

function deleteAccountShape(row) {
    return {
        ...row,
        id: row.account_id,
        access_lane: 'free'
    };
}

async function recordDryRun(row, actorUserId) {
    await query(
        `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES($1,'customer.inactivity.would_remove_jellyfin','customer',$2,$3::jsonb)`,
        [
            actorUserId,
            row.customer_id,
            JSON.stringify({
                planId: row.plan_id,
                planCode: row.plan_code,
                accountId: row.account_id,
                serverId: row.server_id,
                allocationStartAt: row.allocation_start_at || null,
                firstPlaybackAt: row.first_playback_at || null,
                lastPlaybackAt: row.last_playback_at || null,
                playbackMinutes: Math.floor(Number(row.playback_seconds || 0) / 60),
                triggers: row.triggers,
                portalAccountPreserved: true
            })
        ]
    );
}

async function removeEligibleAccount(row, actorUserId) {
    const reason = `Free Server inactivity: ${row.triggers.join('; ')}`;
    await accessHolds.addHold({
        customerId: row.customer_id,
        type: base.HOLD_TYPE,
        sourceKey: `plan:${row.plan_id}`,
        reason,
        actorUserId,
        metadata: {
            accountId: row.account_id,
            serverId: row.server_id,
            triggers: row.triggers
        }
    });

    try {
        await provisioning.deleteJellyfinAccount(
            deleteAccountShape(row),
            { reason, actorUserId }
        );
        await verifyRemoved(row.account_id);
    } catch (error) {
        // A failed DELETE leaves the current account usable and retryable. Do
        // not run the general entitlement reconciler here; that is precisely
        // the unrelated path that previously fought inactivity enforcement.
        await accessHolds.releaseHold({
            customerId: row.customer_id,
            type: base.HOLD_TYPE,
            sourceKey: `plan:${row.plan_id}`,
            actorUserId,
            resolutionReason: 'Inactivity deletion failed; retry on next run'
        }).catch(() => {});

        await query(
            `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
             VALUES($1,'customer.inactivity.remove_failed','customer',$2,$3::jsonb)`,
            [
                actorUserId,
                row.customer_id,
                JSON.stringify({
                    planId: row.plan_id,
                    accountId: row.account_id,
                    serverId: row.server_id,
                    error: String(error?.message || error).slice(0, 500)
                })
            ]
        ).catch(() => {});
        throw error;
    }

    // Record "removed" only after the remote user and local mapping are gone.
    await query(
        `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES($1,'customer.inactivity.remove_jellyfin','customer',$2,$3::jsonb)`,
        [
            actorUserId,
            row.customer_id,
            JSON.stringify({
                planId: row.plan_id,
                planCode: row.plan_code,
                accountId: row.account_id,
                serverId: row.server_id,
                allocationStartAt: row.allocation_start_at || null,
                firstPlaybackAt: row.first_playback_at || null,
                lastPlaybackAt: row.last_playback_at || null,
                playbackMinutes: Math.floor(Number(row.playback_seconds || 0) / 60),
                triggers: row.triggers,
                portalAccountPreserved: true
            })
        ]
    );
}

async function runPlanRules({ actorUserId = null, forceDryRun = null } = {}) {
    const globalCfg = await lifecyclePolicy.get();
    const released = await base.releaseObsoletePlanHolds(actorUserId);

    if (!globalCfg.enabled) {
        return {
            processed: 0,
            eligible: 0,
            enforced: 0,
            wouldRemove: 0,
            failed: 0,
            released,
            dryRun: true,
            skipped: globalCfg.configurationMissing
                ? 'lifecycle_configuration_missing'
                : 'lifecycle_disabled'
        };
    }

    const worker = await activityWorkerTelemetry();
    if (!worker.ready) {
        return {
            processed: 0,
            eligible: 0,
            enforced: 0,
            wouldRemove: 0,
            failed: 1,
            released,
            dryRun: true,
            skipped: 'activity_worker_stale',
            warning: 'Free Server inactivity is paused because playback collection is stale.',
            telemetry: telemetrySummary(worker, {})
        };
    }

    const rows = await legacyGrace.applyLegacySafetyWindow(await base.candidates(globalCfg));
    const serverTelemetry = await refreshCandidateServers(rows);
    const eligible = eligibleOnReadyServers(rows, serverTelemetry);
    const unsafeEligible = rows.filter(
        row => row?.eligible && !serverTelemetry[String(row.server_id)]?.ready
    );
    const selected = eligible.slice(0, MAX_ENFORCEMENTS_PER_RUN);
    const deferred = Math.max(0, eligible.length - selected.length);

    let enforced = 0;
    let wouldRemove = 0;
    let failed = 0;
    let safetySkipped = unsafeEligible.length;

    for (const row of unsafeEligible) {
        await logSkip(
            row,
            actorUserId,
            serverTelemetry[String(row.server_id)]?.reason || 'server_poll_untrusted',
            serverTelemetry[String(row.server_id)] || null
        );
    }

    for (const original of selected) {
        try {
            await provisioning.reconciliationLock.withCustomerReconciliationLock(
                original.customer_id,
                async () => {
                    const final = await finalEligibility(original, globalCfg);
                    if (!final.ready) {
                        safetySkipped += 1;
                        await logSkip(original, actorUserId, final.reason, final.server || null);
                        return;
                    }

                    const row = final.fresh;
                    const dryRun = forceDryRun === null
                        ? Boolean(row.policy.dryRun)
                        : Boolean(forceDryRun);

                    if (dryRun) {
                        await recordDryRun(row, actorUserId);
                        wouldRemove += 1;
                        return;
                    }

                    await removeEligibleAccount(row, actorUserId);
                    enforced += 1;
                }
            );
        } catch (error) {
            failed += 1;
            console.error('Free Server inactivity removal failed:', {
                accountId: original.account_id,
                error: String(error?.message || error).slice(0, 500)
            });
        }
    }

    const telemetry = telemetrySummary(worker, serverTelemetry);
    const warning = deferred
        ? `${deferred} eligible Free Server removal(s) deferred by the ${MAX_ENFORCEMENTS_PER_RUN}-account throughput cap.`
        : undefined;

    return {
        processed: rows.length,
        eligible: eligible.length,
        enforced,
        wouldRemove,
        failed,
        deferred,
        safetySkipped,
        released,
        warning,
        dryRun: Boolean(selected.length && selected.every(
            row => forceDryRun === true || (forceDryRun === null && row.policy.dryRun)
        )),
        telemetry,
        serverFailures: telemetry.unsafeTargetServers,
        examples: eligible.slice(0, 25).map(row => ({
            customerId: row.customer_id,
            name: row.customer_name,
            plan: row.plan_code,
            server: row.server_name,
            triggers: row.triggers,
            lastPlaybackAt: row.last_playback_at,
            playbackMinutes: Math.floor(Number(row.playback_seconds || 0) / 60)
        }))
    };
}

async function run(options = {}) {
    const planRules = await runPlanRules(options);
    return {
        processed: Number(planRules.processed || 0),
        failed: Number(planRules.failed || 0),
        warning: planRules.warning || undefined,
        planRules
    };
}

module.exports = {
    MAX_ENFORCEMENTS_PER_RUN,
    activityWorkerTelemetry,
    candidateServerIds,
    refreshCandidateServers,
    eligibleOnReadyServers,
    telemetrySummary,
    adminProtectedFreeEntitlement,
    finalEligibility,
    verifyRemoved,
    removeEligibleAccount,
    runPlanRules,
    run,
    base
};
