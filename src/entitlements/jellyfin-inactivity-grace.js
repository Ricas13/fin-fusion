'use strict';

function finite(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function graceHours(row) {
    const policy = row?.policy || {};
    const days = row?.has_playback
        ? finite(policy.playbackWindowDays)
        : finite(policy.firstPlaybackGraceDays);
    return days != null && days > 0 ? days * 24 : 0;
}

function legacySafetyHours(row) {
    const policy = row?.policy || {};
    const first = finite(policy.firstPlaybackGraceDays) || 0;
    const rolling = finite(policy.playbackWindowDays) || 0;
    return Math.max(first, rolling) * 24;
}

function legacyResetNeedsGrace() {
    return true;
}

function laterGraceReference(accountRestoredAt, automationResumedAt) {
    const values = [
        accountRestoredAt ? { at: accountRestoredAt, source: 'admin_restore' } : null,
        automationResumedAt ? { at: automationResumedAt, source: 'automation_resume' } : null
    ].filter(Boolean)
      .map(item => ({ ...item, ms: new Date(item.at).getTime() }))
      .filter(item => Number.isFinite(item.ms))
      .sort((a, b) => b.ms - a.ms);
    return values[0] || null;
}

function graceWindow(reference, hours, now) {
    if (!reference || !Number.isFinite(reference.ms) || !Number.isFinite(hours) || hours <= 0) return null;
    const expiresMs = reference.ms + hours * 3600000;
    return expiresMs > now ? { ...reference, expiresMs } : null;
}

// Runtime allocation resets no longer need a second grace system:
// - a restored account is a newly-created Jellyfin account;
// - leaving Permanent Access uses the override revocation timestamp as the new
//   allocation boundary in customer-inactivity.js.
//
// The only remaining compatibility grace is the one-time September 2026 lane
// backfill marker for accounts whose historical lane boundary could not be
// reconstructed exactly. Once that window expires this function becomes inert.
async function applyRestorationGrace(rows, { now = Date.now() } = {}) {
    const candidates = Array.isArray(rows) ? rows : [];
    return candidates.map(row => {
        const resetAt = row?.inactivity_observation_reset_at;
        if (!resetAt) return row;

        const ms = new Date(resetAt).getTime();
        const window = graceWindow(
            Number.isFinite(ms) ? { at: resetAt, ms, source: 'legacy_lane_backfill' } : null,
            legacySafetyHours(row),
            now
        );
        if (!window) return row;

        const until = new Date(window.expiresMs);
        return {
            ...row,
            eligible: false,
            restoration_grace: true,
            restoration_grace_source: window.source,
            restoration_grace_until: until,
            reasons: [
                ...(row.reasons || []),
                `legacy Free-lane safety observation window until ${until.toISOString()}`
            ]
        };
    });
}

module.exports = {
    graceHours,
    legacySafetyHours,
    legacyResetNeedsGrace,
    laterGraceReference,
    graceWindow,
    applyRestorationGrace
};
