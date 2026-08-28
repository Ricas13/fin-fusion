'use strict';

const lifecycle = require('./lifecycle');
const stripe = require('./stripe');
const paypal = require('./paypal');
const plisio = require('./plisio');

const PROVIDERS = { stripe, paypal, plisio };

async function run({ limit = 25 } = {}) {
    const rows = await lifecycle.claimRetryablePaymentEvents({ limit });
    const summary = { total: rows.length, processed: rows.length, succeeded: 0, failed: 0, unsupported: 0 };
    for (const row of rows) {
        const adapter = PROVIDERS[row.provider];
        if (!adapter?.retryPaymentEvent) {
            await lifecycle.finishPaymentEvent(row, new Error(`No internal retry adapter for provider ${row.provider}`));
            summary.failed++;
            summary.unsupported++;
            continue;
        }
        try {
            const result = await adapter.retryPaymentEvent(row);
            if (result?.processed) summary.succeeded++;
            else summary.failed++;
        } catch (error) {
            await lifecycle.finishPaymentEvent(row, error).catch(() => {});
            summary.failed++;
            console.error('Payment event retry failed:', { eventId: row.id, provider: row.provider, error: error.message });
        }
    }
    return summary;
}

module.exports = { run, PROVIDERS };
