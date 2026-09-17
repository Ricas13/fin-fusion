'use strict';

const scoped = require('./customer-inactivity-scoped');
const lifecyclePolicy = require('../entitlements/jellyfin-lifecycle-policy');
const legacyGrace = require('../entitlements/jellyfin-inactivity-grace');

async function customerStatus(customerId) {
    const globalCfg = await lifecyclePolicy.get();

    // Status remains visible while enforcement is paused.
    const discoveryCfg = globalCfg.enabled
        ? globalCfg
        : { ...globalCfg, enabled: true };

    const worker = await scoped.activityWorkerTelemetry();
    const rows = await legacyGrace.applyRestorationGrace(
        await scoped.base.candidates(discoveryCfg, { customerId })
    );

    let serverTelemetry = {};
    if (rows.length && worker.ready) {
        serverTelemetry = await scoped.refreshCandidateServers(rows);
    }

    const telemetry = scoped.telemetrySummary(worker, serverTelemetry);
    const row = rows[0] || null;
    if (!row) {
        return {
            applies: false,
            telemetry,
            globalEnforcementEnabled: Boolean(globalCfg.enabled)
        };
    }

    const server = serverTelemetry[String(row.server_id)] || null;
    const enforcementReady = Boolean(worker.ready && server?.ready);
    const reasons = Array.isArray(row.reasons) ? [...row.reasons] : [];

    if (!globalCfg.enabled) {
        reasons.push('Free Server inactivity enforcement is paused by the administrator.');
    }
    if (!worker.ready) {
        reasons.push('Free Server inactivity enforcement is paused because playback collection is stale.');
    } else if (!server?.ready) {
        reasons.push('Free Server inactivity enforcement is paused because this server does not have a trustworthy recent playback sample.');
    }

    const playbackSeconds = Math.max(0, Number(row.playback_seconds || 0));
    return {
        applies: true,
        telemetry,
        planName: row.plan_name || row.plan_code || 'Free Server',
        planCode: row.plan_code || null,
        allocationStartAt: row.allocation_start_at || null,
        firstPlaybackAt: row.first_playback_at || null,
        lastPlaybackAt: row.last_playback_at || null,
        lastActivityAt: row.last_activity_at || null,
        inactiveReferenceAt: row.inactive_reference_at || null,
        observationStartedAt: row.observation_started_at || null,
        hasPlayback: Boolean(row.has_playback),
        playbackSeconds,
        playbackMinutes: Math.floor(playbackSeconds / 60),
        currentlyPlaying: Boolean(row.currently_playing),
        alreadyHeld: Boolean(row.already_held),
        policyEligible: Boolean(row.eligible),
        eligible: Boolean(row.eligible && globalCfg.enabled && enforcementReady),
        enforcementReady,
        globalEnforcementEnabled: Boolean(globalCfg.enabled),
        triggers: Array.isArray(row.triggers) ? row.triggers : [],
        reasons,
        policy: row.policy || {}
    };
}

module.exports = { customerStatus };
