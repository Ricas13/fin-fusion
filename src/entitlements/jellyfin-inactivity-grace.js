'use strict';

function legacySafetyHours(row) {
    const policy = row?.policy || {};
    const first = Number(policy.firstPlaybackGraceDays) || 0;
    const rolling = Number(policy.playbackWindowDays) || 0;
    return Math.max(first, rolling) * 24;
}

// One migration-only safety net. September 2026 introduced a reliable
// access_lane_changed_at boundary, but older Free rows could not all be
// reconstructed exactly. Those rows were stamped once with
// inactivity_observation_reset_at. Until one complete policy window has passed
// from that stamp, deletion is suppressed. New allocations/restores do NOT use
// this mechanism; their allocation clock is authoritative.
async function applyLegacySafetyWindow(rows, { now = Date.now() } = {}) {
    const candidates = Array.isArray(rows) ? rows : [];
    return candidates.map(row => {
        const resetAt = row?.inactivity_observation_reset_at;
        if (!resetAt) return row;

        const resetMs = new Date(resetAt).getTime();
        const hours = legacySafetyHours(row);
        if (!Number.isFinite(resetMs) || hours <= 0) return row;

        const expiresMs = resetMs + hours * 3600000;
        if (expiresMs <= now) return row;

        const until = new Date(expiresMs);
        return {
            ...row,
            eligible: false,
            restoration_grace: true,
            restoration_grace_source: 'legacy_lane_backfill',
            restoration_grace_until: until,
            reasons: [
                ...(row.reasons || []),
                `legacy Free-lane safety window until ${until.toISOString()}`
            ]
        };
    });
}

module.exports = { applyLegacySafetyWindow };
