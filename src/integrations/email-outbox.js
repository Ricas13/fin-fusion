'use strict';

const { query, transaction } = require('../db');
const { encryptWithEnv, decryptWithEnv } = require('../security/purpose-crypto');
const emailSettings = require('./email-settings');

const PREFIX = 'mail1';
const KEY_ENV = 'DATA_ENCRYPTION_KEY';
const STALE_SENDING_MINUTES = 15;

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
    const result = await query(`
        INSERT INTO notification_outbox(channel,message_type,recipient_email,payload_encrypted,dedupe_key,status,next_attempt_at)
        VALUES('email',$1,$2,$3,$4,'pending',NOW())
        ON CONFLICT(dedupe_key) DO UPDATE SET updated_at=notification_outbox.updated_at
        RETURNING id,status,created_at
    `, [cleanText(type || 'transactional', 100), recipient, encryptPayload(payload), key]);
    return result.rows[0];
}

async function claimOne() {
    return transaction(async client => {
        const found = await client.query(`
            SELECT id FROM notification_outbox
            WHERE channel='email' AND (
                (status IN ('pending','failed') AND next_attempt_at<=NOW())
                OR (status='sending' AND last_attempt_at<=NOW()-make_interval(mins=>$1))
            )
            ORDER BY CASE WHEN status='sending' THEN last_attempt_at ELSE next_attempt_at END,created_at
            FOR UPDATE SKIP LOCKED LIMIT 1
        `, [STALE_SENDING_MINUTES]);
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

async function deliverOne(row, sender = emailSettings.send) {
    const payload = decryptPayload(row.payload_encrypted);
    try {
        await sender({ to: row.recipient_email, subject: payload.subject, text: payload.text, html: payload.html || '' });
        await query(`
            UPDATE notification_outbox
            SET status='sent',sent_at=NOW(),last_error=NULL,updated_at=NOW()
            WHERE id=$1 AND channel='email'
        `, [row.id]);
        return { id: row.id, ok: true };
    } catch (error) {
        const next = new Date(Date.now() + retryDelayMs(row.attempts));
        await query(`
            UPDATE notification_outbox
            SET status='failed',last_error=$2,next_attempt_at=$3,updated_at=NOW()
            WHERE id=$1 AND channel='email'
        `, [row.id, String(error?.message || error).slice(0, 1500), next]);
        return { id: row.id, ok: false, error: error.message };
    }
}

async function deliverDue({ limit = 20, sender = emailSettings.send } = {}) {
    const max = Math.max(1, Math.min(100, Number(limit) || 20));
    const result = { attempted: 0, sent: 0, failed: 0, items: [] };
    for (let index = 0; index < max; index += 1) {
        const row = await claimOne();
        if (!row) break;
        result.attempted += 1;
        const delivered = await deliverOne(row, sender);
        result.items.push(delivered);
        if (delivered.ok) result.sent += 1;
        else result.failed += 1;
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
        WHERE id=$1 AND channel='email' RETURNING id,status
    `, [id]);
    if (!result.rowCount) throw new Error('Email delivery not found.');
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
               COUNT(*) FILTER (WHERE status='sent')::int AS sent
        FROM notification_outbox
        WHERE channel='email'
    `);
    return result.rows[0] || { total: 0, pending: 0, failed: 0, sent: 0 };
}

module.exports = { enqueue, deliverDue, deliverOne, retry, recent, counts, retryDelayMs, encryptPayload, decryptPayload, STALE_SENDING_MINUTES };
