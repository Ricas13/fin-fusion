'use strict';

const { query } = require('../db');

function finite(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function graceHours(row) {
    const policy = row?.policy || {};
    const minimumObservationHours = finite(policy.minimumObservationHours);
    const firstPlaybackGraceDays = finite(policy.firstPlaybackGraceDays);
    // A restored Free allocation that has not played yet is in the activation
    // phase, so its explicit restoration grace must match the first-play rule
    // rather than accidentally expanding to the longer retention window.
    if (!row?.has_playback && firstPlaybackGraceDays != null && firstPlaybackGraceDays > 0) {
        return Math.max(minimumObservationHours != null && minimumObservationHours > 0 ? minimumObservationHours : 0, firstPlaybackGraceDays * 24);
    }
    const windows = [];
    const noPlaybackDays = finite(policy.noPlaybackDays);
    const playbackWindowDays = finite(policy.playbackWindowDays);
    const minimumPlaybackMinutes = finite(policy.minimumPlaybackMinutes);
    if (minimumObservationHours != null && minimumObservationHours > 0) windows.push(minimumObservationHours);
    if (noPlaybackDays != null && noPlaybackDays > 0) windows.push(noPlaybackDays * 24);
    if (minimumPlaybackMinutes != null && minimumPlaybackMinutes > 0 && playbackWindowDays != null && playbackWindowDays > 0) windows.push(playbackWindowDays * 24);
    return windows.length ? Math.max(...windows) : 0;
}

function legacySafetyHours(row) {
    const policy = row?.policy || {};
    const windows = [];
    const minimumObservationHours = finite(policy.minimumObservationHours);
    const firstPlaybackGraceDays = finite(policy.firstPlaybackGraceDays);
    const noPlaybackDays = finite(policy.noPlaybackDays);
    const playbackWindowDays = finite(policy.playbackWindowDays);
    const minimumPlaybackMinutes = finite(policy.minimumPlaybackMinutes);

    if (minimumObservationHours != null && minimumObservationHours > 0) windows.push(minimumObservationHours);
    if (firstPlaybackGraceDays != null && firstPlaybackGraceDays > 0) windows.push(firstPlaybackGraceDays * 24);
    if (noPlaybackDays != null && noPlaybackDays > 0) windows.push(noPlaybackDays * 24);
    if (minimumPlaybackMinutes != null && minimumPlaybackMinutes > 0 && playbackWindowDays != null && playbackWindowDays > 0) windows.push(playbackWindowDays * 24);
    return windows.length ? Math.max(...windows) : 0;
}

function laterGraceReference(accountRestoredAt, automationResumedAt) {
    const references = [
        accountRestoredAt ? { at: accountRestoredAt, source: 'admin_restore' } : null,
        automationResumedAt ? { at: automationResumedAt, source: 'automation_resume' } : null
    ].filter(Boolean).map(reference => ({ ...reference, ms: new Date(reference.at).getTime() })).filter(reference => Number.isFinite(reference.ms));
    if (!references.length) return null;
    references.sort((a, b) => b.ms - a.ms);
    return references[0];
}

function graceWindow(reference, hours, now) {
    if (!reference || !Number.isFinite(reference.ms) || !Number.isFinite(hours) || hours <= 0) return null;
    const expiresMs = reference.ms + hours * 3600000;
    if (expiresMs <= now) return null;
    return { ...reference, expiresMs };
}

async function applyRestorationGrace(rows, { now = Date.now() } = {}) {
    const candidates = Array.isArray(rows) ? rows : [];
    const accountIds = [...new Set(candidates.map(row => row?.account_id).filter(Boolean).map(String))];
    const customerIds = [...new Set(candidates.map(row => row?.customer_id).filter(Boolean).map(String))];
    if (!accountIds.length && !customerIds.length) return candidates;

    // An explicit admin re-enable starts a fresh observation window. Returning
    // a manually protected/permanent customer to automation must do the same:
    // while protected, inactivity enforcement was intentionally suspended, so
    // old activity timestamps must not make the very next worker run delete the
    // account immediately.
    //
    // Separately, the 2026-09 legacy lane-boundary repair marks only Free-lane
    // accounts whose access_lane_changed_at value came from an inherently
    // ambiguous historical backfill. Those rows get a full retention/usage
    // observation window. This deliberately differs from a normal restore: we
    // must not convert an established Free user into a fresh 3-day first-play
    // allocation merely because their old lane boundary could not be proven.
    const [restored, resumed, legacyReset] = await Promise.all([
        accountIds.length ? query(`
            SELECT account_id,MAX(restored_at) restored_at
            FROM jellyfin_account_lifecycle
            WHERE account_id=ANY($1::uuid[])
              AND category='free'
              AND restored_at IS NOT NULL
              AND metadata->>'restoredReason'='admin_reenable'
              AND metadata->>'explicitRestore'='true'
            GROUP BY account_id
        `, [accountIds]) : { rows: [] },
        customerIds.length ? query(`
            SELECT customer_id,MAX(revoked_at) resumed_at
            FROM customer_entitlement_overrides
            WHERE customer_id=ANY($1::uuid[])
              AND permanent_access=FALSE
              AND revoked_at IS NOT NULL
            GROUP BY customer_id
        `, [customerIds]) : { rows: [] },
        accountIds.length ? query(`
            SELECT id AS account_id,inactivity_observation_reset_at
            FROM jellyfin_accounts
            WHERE id=ANY($1::uuid[])
              AND inactivity_observation_reset_at IS NOT NULL
        `, [accountIds]) : { rows: [] }
    ]);
    const restoredByAccount = new Map(restored.rows.map(row => [String(row.account_id), row.restored_at]));
    const resumedByCustomer = new Map(resumed.rows.map(row => [String(row.customer_id), row.resumed_at]));
    const legacyResetByAccount = new Map(legacyReset.rows.map(row => [String(row.account_id), row.inactivity_observation_reset_at]));

    return candidates.map(row => {
        const windows = [];
        const ordinaryReference = laterGraceReference(
            restoredByAccount.get(String(row.account_id)),
            resumedByCustomer.get(String(row.customer_id))
        );
        const ordinaryWindow = graceWindow(ordinaryReference, graceHours(row), now);
        if (ordinaryWindow) windows.push(ordinaryWindow);

        const legacyAt = legacyResetByAccount.get(String(row.account_id));
        if (legacyAt) {
            const ms = new Date(legacyAt).getTime();
            const legacyWindow = graceWindow(
                Number.isFinite(ms) ? { at: legacyAt, ms, source: 'legacy_lane_backfill' } : null,
                legacySafetyHours(row),
                now
            );
            if (legacyWindow) windows.push(legacyWindow);
        }

        if (!windows.length) return row;
        windows.sort((a, b) => b.expiresMs - a.expiresMs);
        const selected = windows[0];
        const until = new Date(selected.expiresMs);
        const reason = selected.source === 'automation_resume'
            ? `returned to automation observation window until ${until.toISOString()}`
            : selected.source === 'legacy_lane_backfill'
                ? `legacy Free-lane safety observation window until ${until.toISOString()}`
                : `admin restore observation window until ${until.toISOString()}`;
        return {
            ...row,
            eligible: false,
            restoration_grace: true,
            restoration_grace_source: selected.source,
            restoration_grace_until: until,
            reasons: [...(row.reasons || []).filter(item => item !== 'already held'), reason]
        };
    });
}

module.exports = { graceHours, legacySafetyHours, laterGraceReference, graceWindow, applyRestorationGrace };
