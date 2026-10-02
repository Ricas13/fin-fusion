'use strict';

const { query } = require('../db');
const accessHolds = require('../entitlements/access-holds');
const lifecyclePolicy = require('../entitlements/jellyfin-lifecycle-policy');
const legacyGrace = require('../entitlements/jellyfin-inactivity-grace');
const subscriptionState = require('../entitlements/subscription-state');
const customerAccessState = require('../access/customer-access-state');
const subscriptionTermination = require('../payments/subscription-termination');
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
    return customerAccessState.operatorProtected(entitlement);
}

function freePlanEndReference(subscriptionId) {
    return `free-access-inactivity:${subscriptionId}`;
}

async function finishRemovedFreePlan(row, actorUserId = null) {
    const sourceKey = `plan:${row.plan_id}`;
    const reason = String(
        row.removal_reason
        || row.reason
        || `Free Server inactivity: ${Array.isArray(row.triggers) ? row.triggers.join('; ') : 'activity requirements were not met'}`
    ).slice(0, 500);

    const ended = await subscriptionTermination.terminateLocal(
        row.subscription_id,
        row.customer_id,
        {
            actorUserId,
            reason,
            reference: freePlanEndReference(row.subscription_id)
        }
    );

    const released = await accessHolds.releaseHold({
        customerId: row.customer_id,
        type: base.HOLD_TYPE,
        sourceKey,
        actorUserId,
        resolutionReason: 'Free Server plan ended after inactivity removal'
    });
    if (released !== 1) {
        const error = new Error('Free Server plan ended, but its inactivity hold was not released exactly once.');
        error.code = 'FREE_INACTIVITY_HOLD_RELEASE_FAILED';
        throw error;
    }

    return { ended, released };
}

async function detachedRemovalRows(limit = MAX_ENFORCEMENTS_PER_RUN) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || MAX_ENFORCEMENTS_PER_RUN));
    const result = await query(`
        SELECT
            h.customer_id,
            h.source_key,
            h.reason AS removal_reason,
            h.metadata,
            s.id AS subscription_id,
            s.plan_id,
            s.status,
            s.current_period_end,
            s.service_extension_days,
            s.superseded_by,
            p.code AS plan_code
        FROM customer_access_holds h
        JOIN subscriptions s
          ON s.customer_id=h.customer_id
         AND s.id::text=h.metadata->>'subscriptionId'
        JOIN plans p ON p.id=s.plan_id
        WHERE h.hold_type=$1
          AND h.released_at IS NULL
          AND h.source_key=('plan:'||s.plan_id::text)
          AND p.is_free_tier=TRUE
          AND COALESCE(p.is_addon,FALSE)=FALSE
          AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('jellyfin','bundle')
          AND (
              (
                  h.metadata->>'accountId' IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1
                      FROM jellyfin_accounts removed
                      WHERE removed.id::text=h.metadata->>'accountId'
                  )
              )
              OR (
                  -- Older inactivity removals could leave the Free plan alive,
                  -- then record a failed restore without retaining the deleted
                  -- account id. Those rows are terminal under the current
                  -- invariant too: active Free plan + no Free account is not a
                  -- valid steady state.
                  COALESCE(h.metadata,'{}'::jsonb) @> '{"restoreReconcileFailed":true}'::jsonb
                  AND h.reason='Free Server inactivity restore pending successful reprovisioning'
              )
          )
          AND (
              NOT EXISTS (
                  SELECT 1
                  FROM jellyfin_accounts present
                  JOIN jellyfin_servers js ON js.id=present.server_id
                  WHERE present.customer_id=h.customer_id
                    AND present.account_purpose='jellyfin'
                    AND present.access_lane='free'
                    AND present.disabled=FALSE
                    AND js.enabled=TRUE
                    AND COALESCE(js.media_server_type,'jellyfin')='jellyfin'
              )
              -- If a protected retry already recreated the Free account but
              -- the subsequent hold release failed, keep surfacing this row so
              -- the finalizer can retry the release. Server pin is not access
              -- authority because subscription_admin_present() deliberately
              -- excludes admin_server_pin.
              OR public.subscription_admin_present(h.customer_id,'jellyfin',s.id)
          )
        ORDER BY h.created_at,h.id
        LIMIT $2
    `, [base.HOLD_TYPE, safeLimit]);
    return result.rows;
}

function subscriptionAlreadyEnded(row, now = Date.now()) {
    const status = String(row?.status || '').toLowerCase();
    if (!['cancelled', 'canceled', 'expired', 'refunded'].includes(status)) return false;
    const extensionDays = Math.max(0, Number(row?.service_extension_days || 0));
    if (extensionDays > 0) return false;
    const end = row?.current_period_end ? new Date(row.current_period_end).getTime() : NaN;
    return Number.isFinite(end) ? end <= now : true;
}

async function finalizeDetachedRemovalLocked(row, actorUserId = null) {
    const current = await subscriptionState.liveFreeJellyfinSubscription(
        row.customer_id,
        { includeBlocked: true }
    );
    const sameSubscription = current
        && String(current.subscription_id || '') === String(row.subscription_id || '');

    if (sameSubscription && adminProtectedFreeEntitlement(current)) {
        // We already own the same per-customer reconciliation lock used by
        // administrator authority mutations. Restore only the Free lane here
        // instead of recursively calling reconcileCustomer(), which would try
        // to acquire the same advisory lock again.
        const primary = await subscriptionState.effectiveSubscription(
            row.customer_id,
            { includeBlocked: true }
        );
        const hasPrimary = Boolean(primary && !primary.is_free_tier);
        const accounts = await provisioning.normalAccounts(row.customer_id);
        const restored = await provisioning.reconcileLane(
            row.customer_id,
            current,
            'free',
            accounts,
            { makePrimary: !hasPrimary }
        );
        if (!(restored?.active && restored?.account && !restored.account.disabled)) {
            const error = new Error('Protected Free entitlement could not be restored to an enabled Free Server account.');
            error.code = 'FREE_INACTIVITY_PROTECTED_RESTORE_FAILED';
            throw error;
        }
        const released = await accessHolds.releaseHold({
            customerId: row.customer_id,
            type: base.HOLD_TYPE,
            sourceKey: row.source_key,
            actorUserId,
            resolutionReason: 'Explicit administrator authority restored Free access after interrupted inactivity removal'
        });
        if (released !== 1) {
            const error = new Error('Protected Free access was restored, but its inactivity hold was not released exactly once.');
            error.code = 'FREE_INACTIVITY_PROTECTED_HOLD_RELEASE_FAILED';
            throw error;
        }
        return { protected: 1, released, finalized: 0 };
    }

    if (!row.superseded_by) {
        // Always run the canonical termination, even for a subscription
        // already labelled cancelled/expired. It clears service-extension
        // time and clamps the access end to NOW(), preventing a cancelled
        // row from remaining effectively live after the hold is released.
        await subscriptionTermination.terminateLocal(
            row.subscription_id,
            row.customer_id,
            {
                actorUserId,
                reason: row.removal_reason || 'Free Server plan ended after inactivity removal',
                reference: freePlanEndReference(row.subscription_id)
            }
        );
    }

    const released = await accessHolds.releaseHold({
        customerId: row.customer_id,
        type: base.HOLD_TYPE,
        sourceKey: row.source_key,
        actorUserId,
        resolutionReason: 'Completed Free Server inactivity plan closure'
    });
    if (released !== 1) {
        const error = new Error('Completed Free inactivity plan closure did not release its hold exactly once.');
        error.code = 'FREE_INACTIVITY_HOLD_RELEASE_FAILED';
        throw error;
    }

    await query(
        `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES($1,'customer.inactivity.finalize_free_plan','customer',$2,$3::jsonb)`,
        [
            actorUserId,
            row.customer_id,
            JSON.stringify({
                subscriptionId: row.subscription_id,
                planId: row.plan_id,
                planCode: row.plan_code,
                activePlanRetained: false,
                portalAccountPreserved: true,
                recoveredAfterAccountDeletion: true,
                inactivityHoldReleased: Boolean(released)
            })
        ]
    ).catch(() => {});

    return { protected: 0, released, finalized: 1 };
}

async function finalizeDetachedRemovals({ actorUserId = null, limit = MAX_ENFORCEMENTS_PER_RUN } = {}) {
    const rows = await detachedRemovalRows(limit);
    const summary = { processed: rows.length, finalized: 0, released: 0, protected: 0, failed: 0 };

    for (const row of rows) {
        try {
            // Detached completion is just as destructive as the live inactivity
            // path. Keep the authority re-check, account restore/plan close and
            // hold release under one customer correctness lock so a newer
            // administrator command cannot be overtaken by an older finalizer.
            const outcome = await provisioning.reconciliationLock.withCustomerReconciliationLock(
                row.customer_id,
                () => finalizeDetachedRemovalLocked(row, actorUserId)
            );
            summary.finalized += Number(outcome?.finalized || 0);
            summary.released += Number(outcome?.released || 0);
            summary.protected += Number(outcome?.protected || 0);
        } catch (error) {
            summary.failed += 1;
            await query(
                `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
                 VALUES($1,'customer.inactivity.finalize_free_plan_failed','customer',$2,$3::jsonb)`,
                [
                    actorUserId,
                    row.customer_id,
                    JSON.stringify({
                        subscriptionId: row.subscription_id,
                        planId: row.plan_id,
                        error: String(error?.message || error).slice(0, 500)
                    })
                ]
            ).catch(() => {});
        }
    }

    return summary;
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
            reason: fresh?.legacy_safety_window
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
    if (
        String(entitlement.subscription_id || '') !== String(fresh.subscription_id || '')
        || String(entitlement.plan_id || '') !== String(fresh.plan_id || '')
    ) {
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
                subscriptionId: row.subscription_id,
                accountId: row.account_id,
                serverId: row.server_id,
                allocationStartAt: row.allocation_start_at || null,
                firstPlaybackAt: row.first_playback_at || null,
                lastPlaybackAt: row.last_playback_at || null,
                playbackMinutes: Math.floor(Number(row.playback_seconds || 0) / 60),
                triggers: row.triggers,
                portalAccountPreserved: true,
                wouldEndFreePlan: true,
                wouldRetainActivePlan: false
            })
        ]
    );
}

async function removeEligibleAccount(row, actorUserId) {
    const reason = `Free Server inactivity: ${row.triggers.join('; ')}`;
    const account = deleteAccountShape(row);

    // Check the live Jellyfin session list before changing entitlement state.
    // The delete primitive repeats the same check after the hold is created, so
    // playback that begins in either race window fails closed.
    await provisioning.assertNoActivePlaybackBeforeDelete(account);

    await accessHolds.addHold({
        customerId: row.customer_id,
        type: base.HOLD_TYPE,
        sourceKey: `plan:${row.plan_id}`,
        reason,
        actorUserId,
        metadata: {
            subscriptionId: row.subscription_id,
            accountId: row.account_id,
            serverId: row.server_id,
            triggers: row.triggers
        }
    });

    try {
        await provisioning.deleteJellyfinAccount(
            account,
            { reason, actorUserId, requireNoActivePlayback: true }
        );
        await verifyRemoved(row.account_id);

        // Inactivity removal is a terminal Free-plan event. The customer portal
        // account remains, but the Free subscription itself is ended and the
        // capacity reservation is released. There is no retained/restorable
        // Free entitlement after a successful removal.
        await finishRemovedFreePlan({ ...row, removal_reason: reason }, actorUserId);
    } catch (error) {
        if (error?.code === 'JELLYFIN_ACTIVE_PLAYBACK_DELETE_BLOCKED') {
            // If this run created the hold and playback started between the
            // preflight and destructive-boundary checks, undo only our new
            // hold. A pre-existing retry hold remains authoritative.
            if (!row.repairExistingHold) {
                await accessHolds.releaseHold({
                    customerId: row.customer_id,
                    type: base.HOLD_TYPE,
                    sourceKey: `plan:${row.plan_id}`,
                    actorUserId,
                    resolutionReason: 'Playback started before inactivity deletion'
                });
            }
            throw error;
        }

        // Keep the hold active on any partial failure. If the Jellyfin identity
        // was already deleted but plan termination/release failed, the detached
        // finalizer above completes that exact subscription on a later run.
        await query(
            `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
             VALUES($1,'customer.inactivity.remove_failed','customer',$2,$3::jsonb)`,
            [
                actorUserId,
                row.customer_id,
                JSON.stringify({
                    planId: row.plan_id,
                    subscriptionId: row.subscription_id,
                    accountId: row.account_id,
                    serverId: row.server_id,
                    error: String(error?.message || error).slice(0, 500)
                })
            ]
        ).catch(() => {});
        throw error;
    }

    // Record "removed" only after the Jellyfin identity is gone, the Free plan
    // is ended, and its inactivity hold has been released.
    await query(
        `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
         VALUES($1,'customer.inactivity.remove_jellyfin','customer',$2,$3::jsonb)`,
        [
            actorUserId,
            row.customer_id,
            JSON.stringify({
                planId: row.plan_id,
                planCode: row.plan_code,
                subscriptionId: row.subscription_id,
                accountId: row.account_id,
                serverId: row.server_id,
                allocationStartAt: row.allocation_start_at || null,
                firstPlaybackAt: row.first_playback_at || null,
                lastPlaybackAt: row.last_playback_at || null,
                playbackMinutes: Math.floor(Number(row.playback_seconds || 0) / 60),
                triggers: row.triggers,
                portalAccountPreserved: true,
                freePlanEnded: true,
                activePlanRetained: false,
                inactivityHoldReleased: true
            })
        ]
    );
}

async function runPlanRules({ actorUserId = null } = {}) {
    // Finish any older/partial inactivity removals where the Jellyfin identity
    // is already gone but the Free subscription was left behind by a previous
    // release. This repair is independent of whether new removals are enabled.
    const detachedFinalization = await finalizeDetachedRemovals({ actorUserId });
    const globalCfg = await lifecyclePolicy.get();
    if (!globalCfg.enabled) {
        return {
            processed: 0,
            eligible: 0,
            enforced: 0,
            wouldRemove: 0,
            failed: Number(detachedFinalization.failed || 0),
            finalizedPlanClosures: detachedFinalization.finalized,
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
            failed: 1 + Number(detachedFinalization.failed || 0),
            finalizedPlanClosures: detachedFinalization.finalized,
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
                    const dryRun = Boolean(row.policy.dryRun);

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
            if (error?.code === 'JELLYFIN_ACTIVE_PLAYBACK_DELETE_BLOCKED') {
                safetySkipped += 1;
                await logSkip(original, actorUserId, 'active_playback_started_before_delete');
                continue;
            }
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
        failed: failed + Number(detachedFinalization.failed || 0),
        finalizedPlanClosures: detachedFinalization.finalized,
        deferred,
        safetySkipped,
        warning,
        dryRun: Boolean(globalCfg.dryRun),
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
    freePlanEndReference,
    finishRemovedFreePlan,
    detachedRemovalRows,
    subscriptionAlreadyEnded,
    finalizeDetachedRemovalLocked,
    finalizeDetachedRemovals,
    finalEligibility,
    verifyRemoved,
    removeEligibleAccount,
    runPlanRules,
    run,
    base
};
