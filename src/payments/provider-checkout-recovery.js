'use strict';

const { query } = require('../db');
const stripe = require('./stripe');
const paypal = require('./paypal');
const checkoutIntents = require('./checkout-intents');
const providerPaymentReconciliation = require('./provider-payment-reconciliation');

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const LOOKBACK_DAYS = 90;
const PAYPAL_RECOVERABLE = new Set(['ACTIVE', 'SUSPENDED']);
const PAYPAL_TERMINAL = new Set(['CANCELLED', 'CANCELED', 'EXPIRED']);

function clampLimit(value) {
    return Math.max(1, Math.min(MAX_LIMIT, Number(value) || DEFAULT_LIMIT));
}

function failureWarning(failures) {
    if (!Array.isArray(failures) || failures.length === 0) return null;
    const shown = failures.slice(0, 3).map(item => {
        const provider = String(item?.provider || 'provider').replace(/\s+/g, ' ').trim().slice(0, 40);
        const reference = String(item?.providerCheckoutId || item?.checkoutIntentId || 'checkout').replace(/\s+/g, ' ').trim().slice(0, 120);
        const error = String(item?.error || 'recovery failed').replace(/[\r\n\t\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 300);
        return `${provider} ${reference}: ${error}`;
    });
    const extra = failures.length > shown.length ? `; +${failures.length - shown.length} more` : '';
    return `${failures.length} provider checkout recovery failure${failures.length === 1 ? '' : 's'}: ${shown.join('; ')}${extra}`.slice(0, 1000);
}

async function candidates({ limit = DEFAULT_LIMIT, checkoutIntentIds = null } = {}) {
    const safeLimit = clampLimit(limit);
    const scopedIds = Array.isArray(checkoutIntentIds)
        ? checkoutIntentIds.map(value => String(value || '').trim()).filter(Boolean)
        : [];
    const scopeSql = scopedIds.length ? 'AND i.id=ANY($3::uuid[])' : '';
    const params = scopedIds.length ? [safeLimit, LOOKBACK_DAYS, scopedIds] : [safeLimit, LOOKBACK_DAYS];
    const result = await query(`
        SELECT i.id,i.customer_id,i.plan_id,i.provider,i.provider_checkout_id,i.checkout_mode,i.state,
               i.provider_terminal_at,i.created_at,i.updated_at,paid.provider_transaction_id AS paid_capture_id
        FROM billing_checkout_intents i
        LEFT JOIN LATERAL (
            SELECT ph.provider_transaction_id
            FROM payment_history_transactions ph
            WHERE i.provider='paypal'
              AND i.checkout_mode='payment'
              AND ph.provider='paypal'
              AND ph.provider_reference_id=i.provider_checkout_id
              AND ph.customer_id=i.customer_id
              AND ph.transaction_status='S'
              AND ph.gross_amount_minor>0
              AND ph.metadata->>'livePaypal'='true'
              AND ph.metadata->>'providerAuthoritative'='true'
              AND ph.metadata->>'feeDataAvailable'='true'
            ORDER BY ph.occurred_at DESC,ph.provider_transaction_id DESC
            LIMIT 1
        ) paid ON TRUE
        WHERE i.provider IN ('stripe','paypal')
          AND i.provider_checkout_id IS NOT NULL
          AND i.created_at >= NOW() - ($2::int * INTERVAL '1 day')
          AND (
              (
                  i.checkout_mode='subscription'
                  AND (
                      i.state IN ('open','failed','expired')
                      OR (i.state='cancelled' AND i.provider_terminal_at IS NULL)
                  )
              )
              OR (
                  i.provider='paypal'
                  AND i.checkout_mode='payment'
                  AND paid.provider_transaction_id IS NOT NULL
                  AND (
                      COALESCE(i.state,'')<>'completed'
                      OR NOT EXISTS (
                          SELECT 1
                          FROM subscriptions s
                          WHERE s.source='paypal'
                            AND s.customer_id=i.customer_id
                            AND s.provider_subscription_id=paid.provider_transaction_id
                      )
                  )
              )
          )
          ${scopeSql}
        ORDER BY i.created_at DESC,i.id DESC
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
        async paypalPaymentOrder(row) {
            return providerPaymentReconciliation.paypalOrderById(row.provider_checkout_id);
        },
        async paypalActivatePayment(row, order) {
            return paypal.activateCompletedOrder(order);
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

async function recoverPayPalPayment(row, handlers) {
    if (!row?.paid_capture_id) throw new Error('PayPal one-time recovery requires an authoritative paid capture.');
    const order = await handlers.paypalPaymentOrder(row);
    const status = paypal.paypalStatus(order?.status);
    if (status !== 'COMPLETED') {
        throw new Error(`PayPal checkout ${row.provider_checkout_id} has an authoritative capture locally but provider order is ${status || 'unknown'}.`);
    }
    const capture = order?.purchase_units?.[0]?.payments?.captures?.[0] || null;
    if (!capture?.id || paypal.paypalStatus(capture.status) !== 'COMPLETED') {
        throw new Error(`PayPal checkout ${row.provider_checkout_id} is completed but its completed capture is missing.`);
    }
    if (String(capture.id) !== String(row.paid_capture_id)) {
        throw new Error(`PayPal checkout ${row.provider_checkout_id} capture does not match the authoritative local payment.`);
    }
    await handlers.paypalActivatePayment(row, order);
    return { state: 'recovered', detail: 'COMPLETED_PAYMENT' };
}

async function recoverPayPal(row, handlers) {
    if (row.checkout_mode === 'payment') return recoverPayPalPayment(row, handlers);

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

    if (summary.failed) summary.warning = failureWarning(summary.failures);
    return summary;
}

module.exports = {
    DEFAULT_LIMIT,
    MAX_LIMIT,
    LOOKBACK_DAYS,
    PAYPAL_RECOVERABLE,
    PAYPAL_TERMINAL,
    clampLimit,
    failureWarning,
    candidates,
    recoverStripe,
    recoverPayPalPayment,
    recoverPayPal,
    run
};
