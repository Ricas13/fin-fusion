'use strict';

const { query, transaction } = require('../db');
const accessHolds = require('../entitlements/access-holds');
const lifecyclePolicy = require('../entitlements/jellyfin-lifecycle-policy');
const planPolicy = require('../entitlements/plan-lifecycle-policy');
const provisioning = require('../jellyfin/resilient-provisioning');
const fleetMetrics = require('../jellyfin/fleet-metrics');
const registry = require('../jellyfin/registry');
const base = require('./customer-inactivity');

async function activityWorkerTelemetry() {
    const worker = await query(`
        SELECT EXTRACT(EPOCH FROM (NOW()-last_heartbeat_at)) age_seconds
        FROM operational_worker_state
        WHERE worker_key='activity'
    `);
    const age = Number(worker.rows[0]?.age_seconds ?? Infinity);
    return {
        ready: Number.isFinite(age) && age < 120,
        activityWorkerAgeSeconds: Number.isFinite(age) ? Math.round(age) : null
    };
}

function candidateServerIds(rows) {
    return [...new Set((rows || [])
        .map(row => row?.server_id == null ? null : String(row.server_id))
        .filter(Boolean))];
}

async function refreshCandidateServers(rows, existing = {}) {
    const telemetry = { ...existing };
    for (const serverId of candidateServerIds(rows)) {
        if (Object.prototype.hasOwnProperty.call(telemetry, serverId)) continue;
        try {
            const refreshed = await fleetMetrics.refreshServerUserActivity(serverId);
            telemetry[serverId] = { ready: true, ...refreshed };
        } catch (error) {
            telemetry[serverId] = {
                ready: false,
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
        ready: Boolean(worker?.ready),
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
        // Do not close the durable lifecycle episode unless the hold that caused
        // the Free lane disable has actually been released. A transient DB error
        // must leave this row retryable rather than stranded disabled forever.
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

    const serverTelemetry = await refreshCandidateServers(rows, {});
    // Re-read after /Users refresh so the final delete decision uses the latest
    // authoritative Jellyfin activity timestamp plus the live playback tracker.
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
            const evidence = { category: 'free', accessLane: 'free', disabledAt: row.disabled_at, deleteAfter: due, planId: row.plan_id, planCode: row.plan_code, dryRun, portalAccountPreserved: true, activityRefreshedImmediatelyBeforeDecision: true };
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

async function runPlanRules({ actorUserId = null, forceDryRun = null } = {}) {
    const globalCfg = await lifecyclePolicy.get();
    const released = await base.releaseObsoletePlanHolds(actorUserId, globalCfg);
    if (!globalCfg.enabled) return { processed: 0, eligible: 0, enforced: 0, wouldDisable: 0, released, dryRun: true, skipped: 'lifecycle_disabled' };

    const worker = await activityWorkerTelemetry();
    if (!worker.ready) {
        // Unlike `lifecycle_disabled` above (a deliberate admin choice), a stale
        // activity-worker heartbeat is an operational fault: it silently blocks
        // every Free Server inactivity disable until the worker recovers, with
        // no other signal in the admin UI. Report it as a failed run (not a
        // quiet 0-processed success) so it surfaces on the automation dashboard
        // and retries sooner than the normal schedule.
        return {
            processed: 0, eligible: 0, enforced: 0, wouldDisable: 0, failed: 1, released, dryRun: true,
            skipped: 'telemetry_not_trustworthy',
            warning: `Free Server inactivity checks are paused: activity worker heartbeat is ${worker.activityWorkerAgeSeconds == null ? 'missing' : `${worker.activityWorkerAgeSeconds}s old`}. No customer will be disabled for inactivity until it recovers.`,
            telemetry: telemetrySummary(worker, {})
        };
    }

    const discovered = await base.candidates(globalCfg);
    let serverTelemetry = await refreshCandidateServers(discovered);
    const rows = discovered.length ? await base.candidates(globalCfg) : discovered;
    serverTelemetry = await refreshCandidateServers(rows, serverTelemetry);
    const eligible = eligibleOnReadyServers(rows, serverTelemetry);
    let enforced = 0, wouldDisable = 0, failed = 0;

    for (const row of eligible) {
        const dryRun = forceDryRun === null ? row.policy.dryRun : Boolean(forceDryRun);
        const evidence = { planId: row.plan_id, planCode: row.plan_code, accessLane: 'free', accountId: row.account_id, serverId: row.server_id, lastPlaybackAt: row.last_playback_at || null, inactiveReferenceAt: row.inactive_reference_at, observationStartedAt: row.observation_started_at, playbackMinutes: Math.round(row.playback_seconds / 60), triggers: row.triggers, dryRun, policyInherited: row.policy.inherited, repairExistingHold: Boolean(row.repairExistingHold), portalAccountPreserved: true, activityRefreshedImmediatelyBeforeDecision: true };
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
                // A failed disable/ledger write must not leave the Free user
                // disabled without a deletion state. Reconcile immediately after
                // rolling the hold back; resilient provisioning will also retain
                // retry state if Jellyfin is still unavailable.
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
    return { processed: rows.length, eligible: eligible.length, enforced, wouldDisable, failed, released, dryRun: eligible.every(row => forceDryRun === true || row.policy.dryRun), telemetry, serverFailures: telemetry.unsafeTargetServers, examples: eligible.slice(0,25).map(row=>({customerId:row.customer_id,name:row.customer_name,plan:row.plan_code,server:row.server_name,triggers:row.triggers,lastPlaybackAt:row.last_playback_at,playbackMinutes:Math.round(row.playback_seconds/60)})) };
}

async function run(options = {}) {
    const globalCfg = await lifecyclePolicy.get();
    const planRules = await runPlanRules(options);
    const deletions = await processPendingDeletions(globalCfg, options);
    return {
        processed: Number(planRules.processed || 0) + Number(deletions.processed || 0),
        failed: Number(planRules.failed || 0) + Number(planRules.serverFailures || 0) + Number(deletions.failed || 0) + Number(deletions.serverFailures || 0),
        warning: planRules.warning || deletions.warning || undefined,
        planRules,
        deletions
    };
}

module.exports = {
    activityWorkerTelemetry,
    candidateServerIds,
    refreshCandidateServers,
    eligibleOnReadyServers,
    telemetrySummary,
    deletionPolicy,
    recordDisabledLifecycle,
    pendingFreeLifecycle,
    activityAfterDisable,
    processPendingDeletions,
    runPlanRules,
    run,
    base
};
