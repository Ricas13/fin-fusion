'use strict';

const { query, transaction } = require('../db');
const { encryptWithEnv, decryptWithEnv } = require('../security/purpose-crypto');
const emailSettings = require('./email-settings');
const freshness = require('./integrity-alert-freshness');

const PREFIX = 'mail1';
const KEY_ENV = 'DATA_ENCRYPTION_KEY';
const STALE_SENDING_MINUTES = 15;
const UNCERTAIN_DELIVERY_ERROR = 'Delivery outcome is uncertain after a worker interruption or post-send database failure. Automatic resend is blocked to prevent duplicate customer messages; review and retry manually if required.';

function validEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    if (!email || !email.includes('@') || /[\r\n<>]/.test(email) || email.length > 254) throw new Error('A valid recipient email address is required.');
    return email;
}
function cleanText(value, max) {
    return String(value || '').replace(/\u0000/g, '').slice(0, max);
}
function encryptPayload(payload) {
    return encryptWithEnv(JSON.stringify(payload), KEY_ENV, PREFIX);
}
function decryptPayload(value) {
    return JSON.parse(decryptWithEnv(value, KEY_ENV, PREFIX));
}
function retryDelayMs(attempts) {
    const schedule = [60e3, 5*60e3, 15*60e3, 60*60e3, 3*60*60e3, 6*60*60e3, 12*60*60e3, 24*60*60e3];
    return schedule[Math.min(schedule.length - 1, Math.max(0, Number(attempts || 1) - 1))];
}

async function enqueue({ type, to, subject, text, html = '', dedupeKey = null }) {
    const recipient = validEmail(to);
    const payload = {
        subject: cleanText(subject, 300),
        text: cleanText(text, 100000),
        html: cleanText(html, 250000)
    };
    if (!payload.subject || !payload.text) throw new Error('Email subject and text body are required.');
    const key = dedupeKey ? cleanText(dedupeKey, 300) : null;
    const delayedUntil = freshness.nextAttemptAt(key);

    return transaction(async client => {
        const result = await client.query(`
            INSERT INTO notification_outbox(channel,message_type,recipient_email,payload_encrypted,dedupe_key,status,next_attempt_at)
            VALUES('email',$1,$2,$3,$4,'pending',NOW())
            ON CONFLICT(dedupe_key) DO UPDATE SET updated_at=notification_outbox.updated_at
            RETURNING id,status,created_at,next_attempt_at
        `, [cleanText(type || 'transactional', 100), recipient, encryptPayload(payload), key]);
        const row = result.rows[0];

        if (row?.status === 'pending' && freshness.fingerprintFromDedupeKey(key)) {
            const delayed = await client.query(`
                UPDATE notification_outbox
                SET next_attempt_at=$2,updated_at=NOW()
                WHERE id=$1 AND status='pending'
                RETURNING id,status,created_at,next_attempt_at
            `, [row.id, delayedUntil]);
            return delayed.rows[0] || row;
        }

        return row;
    });
}

async function quarantineStaleSending() {
    const result = await query(`
        UPDATE notification_outbox
        SET status='dead',last_error=$1,next_attempt_at=NOW(),updated_at=NOW()
        WHERE channel='email' AND status='sending'
          AND last_attempt_at<=NOW()-make_interval(mins=>$2)
        RETURNING id
    `, [UNCERTAIN_DELIVERY_ERROR, STALE_SENDING_MINUTES]);
    return result.rowCount;
}

async function claimOne() {
    return transaction(async client => {
        const found = await client.query(`
            SELECT id FROM notification_outbox
            WHERE channel='email'
              AND status IN ('pending','failed')
              AND next_attempt_at<=NOW()
            ORDER BY next_attempt_at,created_at
            FOR UPDATE SKIP LOCKED LIMIT 1
        `);
        if (!found.rowCount) return null;
        const claimed = await client.query(`
            UPDATE notification_outbox
            SET status='sending',attempts=attempts+1,last_attempt_at=NOW(),updated_at=NOW()
            WHERE id=$1 AND channel='email'
            RETURNING *
        `, [found.rows[0].id]);
        return claimed.rows[0];
    });
}

async function recordConfirmedFailure(row, error) {
    const attempts = Number(row.attempts || 0);
    const dead = attempts >= 8;
    const next = new Date(Date.now() + retryDelayMs(row.attempts));
    await query(`
        UPDATE notification_outbox
        SET status=$2,last_error=$3,next_attempt_at=$4,updated_at=NOW()
        WHERE id=$1 AND channel='email'
    `, [row.id, dead ? 'dead' : 'failed', String(error?.message || error).slice(0, 1500), dead ? new Date() : next]);
    return { id: row.id, ok: false, error: error?.message || String(error), dead };
}

async function recordUncertainDelivery(row, persistenceError) {
    try {
        await query(`
            UPDATE notification_outbox
            SET status='dead',last_error=$2,next_attempt_at=NOW(),updated_at=NOW()
            WHERE id=$1 AND channel='email' AND status='sending'
        `, [row.id, `${UNCERTAIN_DELIVERY_ERROR} Persistence error: ${String(persistenceError?.message || persistenceError).slice(0, 700)}`.slice(0, 1500)]);
    } catch (error) {
        console.error('Unable to quarantine uncertain email delivery.', { id: row.id, error: String(error?.message || error).slice(0, 700) });
    }
    return { id: row.id, ok: false, dead: true, uncertain: true, error: UNCERTAIN_DELIVERY_ERROR };
}

async function deliverOne(row, sender = emailSettings.send) {
    try {
        const gate = await freshness.cancelIfStale(row);
        if (gate.cancelled) return { id: row.id, ok: true, suppressed: true, reason: gate.reason };
    } catch (error) {
        return recordConfirmedFailure(row, error);
    }

    const payload = decryptPayload(row.payload_encrypted);
    try {
        await sender({ to: row.recipient_email, subject: payload.subject, text: payload.text, html: payload.html || '' });
    } catch (error) {
        return recordConfirmedFailure(row, error);
    }
    try {
        await query(`
            UPDATE notification_outbox
            SET status='sent',sent_at=NOW(),last_error=NULL,updated_at=NOW()
            WHERE id=$1 AND channel='email' AND status='sending'
        `, [row.id]);
        return { id: row.id, ok: true };
    } catch (error) {
        // The SMTP call succeeded. Never turn a bookkeeping failure into a blind
        // external resend; quarantine it as uncertain instead.
        return recordUncertainDelivery(row, error);
    }
}

async function deliverDue({ limit = 20, sender = emailSettings.send } = {}) {
    const max = Math.max(1, Math.min(100, Number(limit) || 20));
    const quarantined = await quarantineStaleSending();
    const result = { attempted: 0, sent: 0, failed: 0, suppressed: 0, quarantined, items: [] };
    for (let index = 0; index < max; index += 1) {
        const row = await claimOne();
        if (!row) break;
        result.attempted += 1;
        const delivered = await deliverOne(row, sender);
        result.items.push(delivered);
        if (delivered.suppressed) result.suppressed += 1;
        else if (delivered.ok) result.sent += 1;
        else result.failed += 1;
    }
    if (quarantined) {
        result.failed += quarantined;
        result.warning = `${quarantined} email delivery${quarantined === 1 ? '' : 'ies'} had an uncertain outcome after a worker interruption and were quarantined instead of resent.`;
    }
    return result;
}

async function retry(id) {
    const result = await query(`
        UPDATE notification_outbox
        SET status=CASE WHEN status='sent' THEN status ELSE 'pending' END,
            next_attempt_at=CASE WHEN status='sent' THEN next_attempt_at ELSE NOW() END,
            last_error=CASE WHEN status='sent' THEN last_error ELSE NULL END,
            updated_at=NOW()
        WHERE id=$1 AND channel='email' AND status<>'cancelled' RETURNING id,status
    `, [id]);
    if (!result.rowCount) throw new Error('Email delivery not found or is no longer retryable.');
    return result.rows[0];
}

async function recent(limit = 100) {
    const result = await query(`
        SELECT id,message_type,recipient_email,status,attempts,next_attempt_at,last_attempt_at,sent_at,last_error,created_at
        FROM notification_outbox WHERE channel='email' ORDER BY created_at DESC LIMIT $1
    `, [Math.max(1, Math.min(500, Number(limit) || 100))]);
    return result.rows;
}

async function counts() {
    const result = await query(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE status='pending')::int AS pending,
               COUNT(*) FILTER (WHERE status='failed')::int AS failed,
               COUNT(*) FILTER (WHERE status='dead')::int AS dead,
               COUNT(*) FILTER (WHERE status='sent')::int AS sent,
               COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled
        FROM notification_outbox
        WHERE channel='email'
    `);
    return result.rows[0] || { total: 0, pending: 0, failed: 0, dead: 0, sent: 0, cancelled: 0 };
}

module.exports = { enqueue, deliverDue, deliverOne, retry, recent, counts, retryDelayMs, encryptPayload, decryptPayload, quarantineStaleSending, recordConfirmedFailure, recordUncertainDelivery, STALE_SENDING_MINUTES, UNCERTAIN_DELIVERY_ERROR };
