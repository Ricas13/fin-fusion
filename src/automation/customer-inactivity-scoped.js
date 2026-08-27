'use strict';

const { query } = require('../db');
const accessHolds = require('../entitlements/access-holds');
const lifecyclePolicy = require('../entitlements/jellyfin-lifecycle-policy');
const provisioning = require('../jellyfin/provisioning');
const fleetMetrics = require('../jellyfin/fleet-metrics');
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

async function runPlanRules({ actorUserId = null, forceDryRun = null } = {}) {
    const globalCfg = await lifecyclePolicy.get();
    const released = await base.releaseObsoletePlanHolds(actorUserId, globalCfg);
    if (!globalCfg.enabled) {
        return {
            processed: 0,
            eligible: 0,
            enforced: 0,
            wouldDisable: 0,
            released,
            dryRun: true,
            skipped: 'lifecycle_disabled'
        };
    }

    const worker = await activityWorkerTelemetry();
    if (!worker.ready) {
        return {
            processed: 0,
            eligible: 0,
            enforced: 0,
            wouldDisable: 0,
            released,
            dryRun: true,
            skipped: 'telemetry_not_trustworthy',
            telemetry: telemetrySummary(worker, {})
        };
    }

    // First discover only the servers that actually own Free-plan accounts with
    // an inactivity policy. Refreshing /Users on those servers immediately before
    // evaluation prevents a stale local last_activity_at value from disabling a
    // customer who has used Jellyfin recently. An unrelated offline server is not
    // part of this safety decision.
    const discovered = await base.candidates(globalCfg);
    let serverTelemetry = await refreshCandidateServers(discovered);

    // Re-read candidates after the targeted Jellyfin refresh so eligibility uses
    // the just-observed LastActivityDate/LastLoginDate values. If a candidate was
    // introduced concurrently, refresh that server too before it can be enforced.
    const rows = discovered.length ? await base.candidates(globalCfg) : discovered;
    serverTelemetry = await refreshCandidateServers(rows, serverTelemetry);

    const eligible = eligibleOnReadyServers(rows, serverTelemetry);
    let enforced = 0;
    let wouldDisable = 0;

    for (const row of eligible) {
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
            portalAccountPreserved: true,
            activityRefreshedImmediatelyBeforeDecision: true
        };
        await query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,$2,'customer',$3,$4::jsonb)
        `, [
            actorUserId,
            dryRun ? 'customer.inactivity.would_disable_jellyfin' : 'customer.inactivity.disable_jellyfin',
            row.customer_id,
            JSON.stringify(evidence)
        ]);
        if (dryRun) {
            wouldDisable += 1;
            continue;
        }
        await accessHolds.addHold({
            customerId: row.customer_id,
            type: base.HOLD_TYPE,
            sourceKey: `plan:${row.plan_id}`,
            reason: `Free-plan Jellyfin usage rule: ${row.triggers.join('; ')}`,
            actorUserId,
            metadata: evidence
        });
        await provisioning.reconcileCustomer(row.customer_id);
        enforced += 1;
    }

    const telemetry = telemetrySummary(worker, serverTelemetry);
    return {
        processed: rows.length,
        eligible: eligible.length,
        enforced,
        wouldDisable,
        released,
        dryRun: eligible.every(row => forceDryRun === true || row.policy.dryRun),
        telemetry,
        serverFailures: telemetry.unsafeTargetServers,
        examples: eligible.slice(0, 25).map(row => ({
            customerId: row.customer_id,
            name: row.customer_name,
            plan: row.plan_code,
            server: row.server_name,
            triggers: row.triggers,
            lastPlaybackAt: row.last_playback_at,
            playbackMinutes: Math.round(row.playback_seconds / 60)
        }))
    };
}

async function run(options = {}) {
    const [planRules, cleanup] = await Promise.all([
        runPlanRules(options),
        base.runCleanup(options)
    ]);
    return {
        processed: Number(planRules.processed || 0) + Number(cleanup.processed || 0),
        failed: Number(planRules.serverFailures || 0) + Number(cleanup.failed || 0),
        planRules,
        cleanup
    };
}

module.exports = {
    activityWorkerTelemetry,
    candidateServerIds,
    refreshCandidateServers,
    eligibleOnReadyServers,
    telemetrySummary,
    runPlanRules,
    run,
    base
};
