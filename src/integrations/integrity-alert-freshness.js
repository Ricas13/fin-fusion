'use strict';

const { query } = require('../db');

const INTEGRITY_ALERT_GRACE_MS = 30 * 1000;
const INTEGRITY_DEDUPE_RE = /(?:^|:)automation-integrity:([a-f0-9]{24}):\d+$/i;

function fingerprintFromDedupeKey(value) {
    const match = String(value || '').trim().match(INTEGRITY_DEDUPE_RE);
    return match ? String(match[1]).toLowerCase() : null;
}

function nextAttemptAt(dedupeKey, now = Date.now()) {
    const base = Number(now);
    const safeNow = Number.isFinite(base) ? base : Date.now();
    return new Date(safeNow + (fingerprintFromDedupeKey(dedupeKey) ? INTEGRITY_ALERT_GRACE_MS : 0));
}

async function evaluate(row) {
    const expectedFingerprint = fingerprintFromDedupeKey(row?.dedupe_key);
    if (!expectedFingerprint) return { guarded: false, fresh: true };

    // Lazy import avoids a module-load cycle: revenue-integrity dispatches through
    // the outboxes, while outbox delivery needs a last-moment integrity recheck.
    const integrity = require('../automation/revenue-integrity');
    const findings = await integrity.scan();
    const currentFingerprint = findings.length ? integrity.fingerprint(findings) : null;

    return {
        guarded: true,
        fresh: Boolean(currentFingerprint && currentFingerprint === expectedFingerprint),
        expectedFingerprint,
        currentFingerprint,
        findings: findings.length
    };
}

async function cancelIfStale(row) {
    const state = await evaluate(row);
    if (!state.guarded || state.fresh) return { cancelled: false, ...state };

    const reason = state.findings
        ? `Integrity snapshot changed before delivery (${state.expectedFingerprint} -> ${state.currentFingerprint}).`
        : 'Integrity findings resolved before delivery.';

    const result = await query(`
        UPDATE notification_outbox
        SET status='cancelled',
            payload=COALESCE(payload,'{}'::jsonb) || jsonb_build_object(
                'suppressed_reason',$2::text,
                'suppressed_dedupe_key',dedupe_key,
                'suppressed_at',NOW()
            ),
            dedupe_key=NULL,
            next_attempt_at=NOW(),
            last_error=NULL,
            updated_at=NOW()
        WHERE id=$1 AND status='sending'
        RETURNING id
    `, [row.id, reason]);

    if (!result.rowCount) {
        throw new Error('Unable to suppress stale integrity notification safely.');
    }

    return { cancelled: true, ...state, reason };
}

module.exports = {
    INTEGRITY_ALERT_GRACE_MS,
    fingerprintFromDedupeKey,
    nextAttemptAt,
    evaluate,
    cancelIfStale
};
