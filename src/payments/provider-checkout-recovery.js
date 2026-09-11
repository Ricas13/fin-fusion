'use strict';

const { query } = require('../db');
const stripe = require('./stripe');
const paypal = require('./paypal');
const checkoutIntents = require('./checkout-intents');

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const LOOKBACK_DAYS = 90;
const PAYPAL_RECOVERABLE = new Set(['ACTIVE', 'SUSPENDED']);
const PAYPAL_TERMINAL = new Set(['CANCELLED', 'CANCELED', 'EXPIRED']);

function clampLimit(value) {
    return Math.max(1, Math.min(MAX_LIMIT, Number(value) || DEFAULT_LIMIT));
}

async function candidates({ limit = DEFAULT_LIMIT, checkoutIntentIds = null } = {}) {
    const safeLimit = clampLimit(limit);
    const scopedIds = Array.isArray(checkoutIntentIds)
        ? checkoutIntentIds.map(value => String(value || '').trim()).filter(Boolean)
        : [];
    const scopeSql = scopedIds.length ? 'AND id=ANY($3::uuid[])' : '';
    const params = scopedIds.length ? [safeLimit, LOOKBACK_DAYS, scopedIds] : [safeLimit, LOOKBACK_DAYS];
    const result = await query(`
        SELECT id,customer_id,plan_id,provider,provider_checkout_id,state,
               provider_terminal_at,created_at,updated_at
        FROM billing_checkout_intents
        WHERE provider IN ('stripe','paypal')
          AND checkout_mode='subscription'
          AND provider_checkout_id IS NOT NULL
          AND created_at >= NOW() - ($2::int * INTERVAL '1 day')
          AND (
              state IN ('open','failed','expired')
              OR (state='cancelled' AND provider_terminal_at IS NULL)
          )
          ${scopeSql}
        ORDER BY created_at DESC,id DESC
        LIMIT $1
    `, params);
    return result.rows;
}

function defaultHandlers() {
    return {
        async stripe(row) {
            return stripe.confirmCheckout(row.provider_checkout_id);
        },
        async paypalStatus(row) {
            return paypal.syncCurrentSubscription(row.provider_checkout_id, { activateMissing: false });
        },
        async paypalActivate(row) {
            return paypal.activateSubscription(row.provider_checkout_id);
        },
        async markTerminal(row) {
            return checkoutIntents.completeVerifiedProvider(row.provider, row.provider_checkout_id, 'cancelled');
        },
        async markCompleted(row) {
            return checkoutIntents.completeVerifiedProvider(row.provider, row.provider_checkout_id, 'completed');
        }
    };
}

async function recoverStripe(row, handlers) {
    const outcome = await handlers.stripe(row);
    if (outcome?.completed) return { state: 'recovered', detail: outcome.status || 'completed' };
    if (outcome?.waiting) return { state: 'waiting', detail: outcome.status || 'processing' };
    return { state: 'terminal', detail: outcome?.status || 'terminal' };
}

async function recoverPayPal(row, handlers) {
    const synced = await handlers.paypalStatus(row);
    const providerStatus = paypal.paypalStatus(synced?.providerStatus || synced?.subscription?.status);

    // If a local subscription already exists, the provider checkout did settle at
    // some point. Re-run canonical activation for a live provider so checkout
    // completion is repaired; otherwise preserve the existing provider truth and
    // close the checkout as completed instead of pretending the purchase vanished.
    if (synced?.row) {
        if (PAYPAL_RECOVERABLE.has(providerStatus)) {
            await handlers.paypalActivate(row);
        } else {
            await handlers.markCompleted(row);
        }
        return { state: 'recovered', detail: providerStatus || 'local_subscription_present' };
    }

    if (PAYPAL_RECOVERABLE.has(providerStatus)) {
        await handlers.paypalActivate(row);
        return { state: 'recovered', detail: providerStatus };
    }

    if (PAYPAL_TERMINAL.has(providerStatus)) {
        await handlers.markTerminal(row);
        return { state: 'terminal', detail: providerStatus };
    }

    // APPROVAL_PENDING / APPROVED must never be treated as paid access merely
    // because a local checkout exists. The normal PayPal activation event or a
    // later recovery pass will settle it once PayPal reports ACTIVE.
    return { state: 'waiting', detail: providerStatus || 'provider_pending' };
}

async function run({ limit = DEFAULT_LIMIT, handlers = null, checkoutIntentIds = null } = {}) {
    const rows = await candidates({ limit, checkoutIntentIds });
    const activeHandlers = handlers || defaultHandlers();
    const summary = {
        total: rows.length,
        processed: 0,
        recovered: 0,
        waiting: 0,
        terminal: 0,
        failed: 0,
        failures: []
    };

    for (const row of rows) {
        summary.processed += 1;
        try {
            const result = row.provider === 'stripe'
                ? await recoverStripe(row, activeHandlers)
                : await recoverPayPal(row, activeHandlers);
            summary[result.state] = Number(summary[result.state] || 0) + 1;
        } catch (error) {
            summary.failed += 1;
            summary.failures.push({
                checkoutIntentId: row.id,
                provider: row.provider,
                providerCheckoutId: row.provider_checkout_id,
                error: String(error?.message || error).slice(0, 500)
            });
        }
    }

    return summary;
}

module.exports = {
    DEFAULT_LIMIT,
    MAX_LIMIT,
    LOOKBACK_DAYS,
    PAYPAL_RECOVERABLE,
    PAYPAL_TERMINAL,
    clampLimit,
    candidates,
    recoverStripe,
    recoverPayPal,
    run
};
