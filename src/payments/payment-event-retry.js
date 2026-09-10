'use strict';

const { query } = require('../db');
const lifecycle = require('./lifecycle');
const stripe = require('./stripe');
const paypal = require('./paypal');
const plisio = require('./plisio');

const PROVIDERS = { stripe, paypal, plisio };
const RETRYABLE_PROVIDERS = Object.freeze(Object.keys(PROVIDERS));

function cleanError(value) {
    return String(value?.message || value || 'Unknown payment event retry failure')
        .replace(/[\r\n\t\u2028\u2029]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 300) || 'Unknown payment event retry failure';
}

function addFailure(reasons, value) {
    const reason = cleanError(value);
    reasons.set(reason, Number(reasons.get(reason) || 0) + 1);
}

function failureWarning(summary, reasons) {
    if (!summary.failed) return null;
    const top = [...reasons.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 3)
        .map(([message, count]) => `${count}× ${message}`)
        .join('; ');
    return `${summary.failed} payment event retr${summary.failed === 1 ? 'y' : 'ies'} failed${top ? `: ${top}` : ''}`.slice(0, 1000);
}

async function claimSupportedRetryablePaymentEvents({ limit = 25 } = {}) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
    const result = await query(`
        WITH candidates AS (
            SELECT id
            FROM payment_events
            WHERE provider=ANY($2::text[])
              AND processed_at IS NULL
              AND (
                (processing_error IS NOT NULL AND processing_token IS NULL
                 AND processing_started_at < NOW() - ($3::int * INTERVAL '1 minute'))
                OR
                (processing_token IS NOT NULL
                 AND processing_started_at < NOW() - ($4::int * INTERVAL '1 minute'))
              )
            ORDER BY created_at,id
            LIMIT $1
            FOR UPDATE SKIP LOCKED
        )
        UPDATE payment_events p
           SET processing_started_at=NOW(),processing_token=gen_random_uuid()
          FROM candidates c
         WHERE p.id=c.id
         RETURNING p.id,p.provider,p.provider_event_id,p.event_type,p.payload,p.processing_error,p.processing_started_at,p.processing_token
    `, [safeLimit, RETRYABLE_PROVIDERS, lifecycle.PAYMENT_EVENT_RETRY_MINUTES, lifecycle.PAYMENT_EVENT_LEASE_MINUTES]);
    return result.rows;
}

async function run({ limit = 25 } = {}) {
    // Only claim providers for which this worker has a replay adapter. Manual,
    // imported or future provider rows stay durable/operator-visible instead of
    // poisoning every retry pass forever.
    const rows = await claimSupportedRetryablePaymentEvents({ limit });
    const summary = { total: rows.length, processed: rows.length, succeeded: 0, failed: 0, unsupported: 0 };
    const failureReasons = new Map();
    for (const row of rows) {
        const adapter = PROVIDERS[row.provider];
        if (!adapter?.retryPaymentEvent) {
            const error = new Error(`No internal retry adapter for provider ${row.provider}`);
            await lifecycle.finishPaymentEvent(row, error);
            summary.failed++;
            summary.unsupported++;
            addFailure(failureReasons, error);
            continue;
        }
        try {
            const result = await adapter.retryPaymentEvent(row);
            if (result?.processed) summary.succeeded++;
            else {
                summary.failed++;
                addFailure(failureReasons, result?.error || result?.message || `${row.provider} retry returned processed=false`);
            }
        } catch (error) {
            await lifecycle.finishPaymentEvent(row, error).catch(() => {});
            summary.failed++;
            addFailure(failureReasons, error);
            console.error('Payment event retry failed:', { eventId: row.id, provider: row.provider, error: cleanError(error) });
        }
    }
    const warning = failureWarning(summary, failureReasons);
    return warning ? { ...summary, warning } : summary;
}

module.exports = { run, PROVIDERS, RETRYABLE_PROVIDERS, claimSupportedRetryablePaymentEvents, cleanError, failureWarning };
