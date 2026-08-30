'use strict';

const { query } = require('../db');

function finite(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function graceHours(row) {
    const policy = row?.policy || {};
    const windows = [];
    const minimumObservationHours = finite(policy.minimumObservationHours);
    const noPlaybackDays = finite(policy.noPlaybackDays);
    const playbackWindowDays = finite(policy.playbackWindowDays);
    const minimumPlaybackMinutes = finite(policy.minimumPlaybackMinutes);
    if (minimumObservationHours != null && minimumObservationHours > 0) windows.push(minimumObservationHours);
    if (noPlaybackDays != null && noPlaybackDays > 0) windows.push(noPlaybackDays * 24);
    if (minimumPlaybackMinutes != null && minimumPlaybackMinutes > 0 && playbackWindowDays != null && playbackWindowDays > 0) windows.push(playbackWindowDays * 24);
    return windows.length ? Math.max(...windows) : 0;
}

async function applyRestorationGrace(rows, { now = Date.now() } = {}) {
    const candidates = Array.isArray(rows) ? rows : [];
    const accountIds = [...new Set(candidates.map(row => row?.account_id).filter(Boolean).map(String))];
    if (!accountIds.length) return candidates;

    // Only an explicit admin re-enable starts a fresh observation window. Other
    // lifecycle restorations (playback recovery, policy changes, manual remote
    // toggles, cleanup changes) are evidence about the existing policy episode,
    // not permission to reset the inactivity clock for days.
    const restored = await query(`
        SELECT account_id,MAX(restored_at) restored_at
        FROM jellyfin_account_lifecycle
        WHERE account_id=ANY($1::uuid[])
          AND category='free'
          AND restored_at IS NOT NULL
          AND metadata->>'restoredReason'='admin_reenable'
          AND metadata->>'explicitRestore'='true'
        GROUP BY account_id
    `, [accountIds]);
    const byAccount = new Map(restored.rows.map(row => [String(row.account_id), row.restored_at]));

    return candidates.map(row => {
        const restoredAt = byAccount.get(String(row.account_id));
        const hours = graceHours(row);
        if (!restoredAt || hours <= 0) return row;
        const restoredMs = new Date(restoredAt).getTime();
        if (!Number.isFinite(restoredMs)) return row;
        const expiresMs = restoredMs + hours * 3600000;
        if (expiresMs <= now) return row;
        return {
            ...row,
            eligible: false,
            restoration_grace: true,
            restoration_grace_until: new Date(expiresMs),
            reasons: [...(row.reasons || []).filter(reason => reason !== 'already held'), `admin restore observation window until ${new Date(expiresMs).toISOString()}`]
        };
    });
}

module.exports = { graceHours, applyRestorationGrace };
