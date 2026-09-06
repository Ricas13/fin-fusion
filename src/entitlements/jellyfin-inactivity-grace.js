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

function laterGraceReference(accountRestoredAt, automationResumedAt) {
    const references = [
        accountRestoredAt ? { at: accountRestoredAt, source: 'admin_restore' } : null,
        automationResumedAt ? { at: automationResumedAt, source: 'automation_resume' } : null
    ].filter(Boolean).map(reference => ({ ...reference, ms: new Date(reference.at).getTime() })).filter(reference => Number.isFinite(reference.ms));
    if (!references.length) return null;
    references.sort((a, b) => b.ms - a.ms);
    return references[0];
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
    const [restored, resumed] = await Promise.all([
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
        `, [customerIds]) : { rows: [] }
    ]);
    const restoredByAccount = new Map(restored.rows.map(row => [String(row.account_id), row.restored_at]));
    const resumedByCustomer = new Map(resumed.rows.map(row => [String(row.customer_id), row.resumed_at]));

    return candidates.map(row => {
        const reference = laterGraceReference(
            restoredByAccount.get(String(row.account_id)),
            resumedByCustomer.get(String(row.customer_id))
        );
        const hours = graceHours(row);
        if (!reference || hours <= 0) return row;
        const expiresMs = reference.ms + hours * 3600000;
        if (expiresMs <= now) return row;
        const until = new Date(expiresMs);
        const reason = reference.source === 'automation_resume'
            ? `returned to automation observation window until ${until.toISOString()}`
            : `admin restore observation window until ${until.toISOString()}`;
        return {
            ...row,
            eligible: false,
            restoration_grace: true,
            restoration_grace_source: reference.source,
            restoration_grace_until: until,
            reasons: [...(row.reasons || []).filter(item => item !== 'already held'), reason]
        };
    });
}

module.exports = { graceHours, laterGraceReference, applyRestorationGrace };
