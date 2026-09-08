'use strict';

const lifecycle = require('./lifecycle');
const stripe = require('./stripe');
const paypal = require('./paypal');
const plisio = require('./plisio');

const PROVIDERS = { stripe, paypal, plisio };

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

async function run({ limit = 25 } = {}) {
    const rows = await lifecycle.claimRetryablePaymentEvents({ limit });
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

module.exports = { run, PROVIDERS, cleanError, failureWarning };
