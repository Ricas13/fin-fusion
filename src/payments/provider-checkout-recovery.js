'use strict';

const { query } = require('../db');
const stripe = require('./stripe');
const paypal = require('./paypal');
const plisio = require('./plisio');
const checkoutIntents = require('./checkout-intents');
const providerPaymentReconciliation = require('./provider-payment-reconciliation');
const providerLifecycleState = require('./provider-lifecycle-state');

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const LOOKBACK_DAYS = 90;
// A Plisio invoice stays payable for 180 minutes, but a short or late crypto payment
// can be topped up afterwards, so keep polling for a few days. Checkouts that Plisio
// already reported as failed (e.g. mismatch) are only re-polled for the first 48 hours.
const PLISIO_LOOKBACK_DAYS = 7;
const PLISIO_FAILED_RETRY_HOURS = 48;
// Beyond the fast 7-day window an unresolved Plisio invoice is still checked, once a day, until it is this old.
const PLISIO_AGED_LOOKBACK_DAYS = 90;
const PLISIO_AGED_RECHECK_HOURS = 24;
// Past this age an unverifiable completed payment stops raising a job failure (it would
// otherwise degrade this critical job indefinitely); it stays visible in the audit log.
const PLISIO_UNVERIFIED_ALERT_HOURS = 72;
// An invoice is payable for INVOICE_LIFETIME_MINUTES. After that plus this grace (for slow confirmations and top-ups), an
// invoice Plisio still reports as merely 'new' was never paid: close it locally. A genuine late payment still arrives through
// the signed callback / re-check and activates normally, because only completed payments are allowed to override a closed intent.
const PLISIO_UNPAID_GIVE_UP_HOURS = 24;
// Statuses that mean money may be in flight; these are never given up on by age alone.
const PLISIO_IN_FLIGHT = new Set(['pending', 'pending internal']);
const PAYPAL_RECOVERABLE = new Set(['ACTIVE', 'SUSPENDED']);
const PAYPAL_TERMINAL = new Set(['CANCELLED', 'CANCELED', 'EXPIRED']);
const PAYPAL_LOCALLY_ABANDONED = new Set(['expired', 'cancelled']);

function paypalResourceNotFound(error) {
    if (String(error?.provider || '').toLowerCase() !== 'paypal') return false;
    if (String(error?.code || '') !== 'http_error') return false;
    if (Boolean(error?.retryable)) return false;
    const status = Number(error?.status);
    if (status === 404) return true;
    if (status !== 422) return false;
    return /specified resource does not exist|resource not found|not found/i.test(String(error?.message || ''));
}

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

// ignoreLookback is only passed for an operator's explicit re-check of one named checkout: it skips every age window.
async function candidates({ limit = DEFAULT_LIMIT, checkoutIntentIds = null, ignoreLookback = false } = {}) {
    const safeLimit = clampLimit(limit);
    const scopedIds = Array.isArray(checkoutIntentIds)
        ? checkoutIntentIds.map(value => String(value || '').trim()).filter(Boolean)
        : [];
    const scopeSql = 'AND (cardinality($3::uuid[])=0 OR i.id=ANY($3::uuid[]))';
    const plisioParams = [PLISIO_LOOKBACK_DAYS, PLISIO_FAILED_RETRY_HOURS];
    // $3 is always bound (empty array when unscoped) so $4/$5 keep fixed positions.
    const params = [safeLimit, LOOKBACK_DAYS, scopedIds, ...plisioParams, Boolean(plisio.enabled()), Boolean(ignoreLookback && scopedIds.length), PLISIO_AGED_LOOKBACK_DAYS, PLISIO_AGED_RECHECK_HOURS];
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
              AND (
                  COALESCE(i.state,'')<>'completed'
                  OR (
                      NOT EXISTS (
                          SELECT 1
                          FROM subscriptions s
                          WHERE s.source='paypal'
                            AND s.customer_id=i.customer_id
                            AND s.provider_subscription_id=ph.provider_transaction_id
                      )
                      AND NOT EXISTS (
                          SELECT 1
                          FROM subscription_access_extensions sae
                          WHERE sae.provider='paypal'
                            AND sae.customer_id=i.customer_id
                            AND (
                                sae.provider_payment_id=ph.provider_transaction_id
                                OR sae.checkout_intent_id=i.id
                            )
                      )
                  )
              )
            ORDER BY ph.occurred_at DESC,ph.provider_transaction_id DESC
            LIMIT 1
        ) paid ON TRUE
        WHERE i.provider IN ('stripe','paypal','plisio')
          AND i.provider_checkout_id IS NOT NULL
          AND ($7::boolean OR i.created_at >= NOW() - ($2::int * INTERVAL '1 day'))
          AND (
              (
                  i.provider='plisio'
                  AND $6::boolean
                  AND i.checkout_mode='payment'
                  AND i.operator_resolution IS DISTINCT FROM 'marked_paid'
                  AND i.state IN ('open','failed','expired','cancelled')
                  AND (
                      $7::boolean
                      OR i.created_at >= NOW() - ($4::int * INTERVAL '1 day')
                      -- older but still unresolved: checked once a day (updated_at is touched after each check)
                      OR (i.created_at >= NOW() - ($8::int * INTERVAL '1 day')
                          AND i.provider_terminal_at IS NULL
                          AND i.updated_at < NOW() - ($9::int * INTERVAL '1 hour'))
                  )
                  AND (
                      i.provider_terminal_at IS NULL
                      OR (i.state='failed' AND i.created_at >= NOW() - ($5::int * INTERVAL '1 hour'))
                  )
              )
              OR (
                  i.provider IN ('stripe','paypal')
                  AND (i.provider='stripe' OR i.checkout_mode='subscription')
                  AND i.state IN ('open','failed','expired','cancelled')
                  AND i.provider_terminal_at IS NULL
              )
              OR (
                  i.provider='paypal'
                  AND i.checkout_mode='payment'
                  AND paid.provider_transaction_id IS NOT NULL
              )
          )
          ${scopeSql}
        -- Payments in their payment window first (a customer is waiting), then everything else least-recently-checked first,
        -- so a large backlog is worked through fairly instead of the same newest rows being polled every run.
        ORDER BY (i.created_at >= NOW() - INTERVAL '4 hours') DESC,i.updated_at ASC,i.id ASC
        LIMIT $1
    `, params);
    return result.rows;
}

function defaultHandlers() {
    return {
        async stripe(row) {
            return stripe.confirmCheckout(row.provider_checkout_id);
        },
        async plisio(row) {
            const intent = await checkoutIntents.findById(row.id);
            if (!intent) throw new Error('Plisio checkout intent no longer exists.');
            return plisio.confirmCheckout(row.provider_checkout_id, intent);
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

function plisioUnpaidDeadlineHours() {
    return plisio.INVOICE_LIFETIME_MINUTES / 60 + PLISIO_UNPAID_GIVE_UP_HOURS;
}

async function recoverPlisio(row, handlers) {
    const ageHours = (Date.now() - new Date(row.created_at).getTime()) / 3600000;
    const pastDeadline = Number.isFinite(ageHours) && ageHours > plisioUnpaidDeadlineHours();
    let outcome;
    try {
        outcome = await handlers.plisio(row);
    } catch (error) {
        // Plisio answered that this operation does not exist, long after its payment window: there is nothing to wait for.
        // Timeouts, auth failures and 5xx are never treated this way (providerNotFound is only set for an HTTP 404).
        if (error?.providerNotFound === true && pastDeadline) {
            await handlers.markTerminal(row);
            return { state: 'terminal', detail: 'PROVIDER_NOT_FOUND' };
        }
        throw error;
    }
    if (outcome?.completed) return { state: 'recovered', detail: outcome.status || 'completed' };
    // Plisio says the invoice is paid but the fiat amount cannot be verified, so access
    // cannot be activated safely. Surface it as a failure so the job shows a warning
    // instead of waiting forever with a paid customer and no access.
    if (outcome?.status === 'completed') {
        const ageHours = (Date.now() - new Date(row.created_at).getTime()) / 3600000;
        if (Number.isFinite(ageHours) && ageHours > PLISIO_UNVERIFIED_ALERT_HOURS) {
            return { state: 'waiting', detail: 'completed_unverified' };
        }
        throw new Error(`Plisio ${row.provider_checkout_id} is completed but its fiat amount could not be verified; reconcile it manually.`);
    }
    if (outcome?.terminal) return { state: 'terminal', detail: outcome.status || 'terminal' };
    // Still 'new' (nothing was ever sent) well after the invoice could be paid: close it, no operator needed.
    const waitingStatus = String(outcome?.status || '').toLowerCase();
    if (pastDeadline && outcome?.waiting && waitingStatus === 'new' && !PLISIO_IN_FLIGHT.has(waitingStatus)) {
        await handlers.markTerminal(row);
        return { state: 'terminal', detail: 'UNPAID_TIMEOUT' };
    }
    return { state: 'waiting', detail: outcome?.status || 'pending' };
}

async function recoverPayPalPayment(row, handlers) {
    if (!row?.paid_capture_id) throw new Error('PayPal one-time recovery requires an authoritative paid capture.');
    const order = await handlers.paypalPaymentOrder(row);
    const status = providerLifecycleState.normalizeStatus('paypal',order?.status);
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

    let synced;
    try {
        synced = await handlers.paypalStatus(row);
    } catch (error) {
        const localState = String(row?.state || '').trim().toLowerCase();

        // An attached PayPal checkout that has already been abandoned locally
        // must not poison recovery forever when PayPal confirms that the
        // provider resource no longer exists. provider-http already attempts
        // the legacy billing-agreement API before surfacing the final error.
        //
        // Keep open/failed checkouts visible: a 404 there can indicate a
        // credential, environment or configuration mismatch rather than a
        // genuinely abandoned checkout.
        if (PAYPAL_LOCALLY_ABANDONED.has(localState) && paypalResourceNotFound(error)) {
            await handlers.markTerminal(row);
            return { state: 'terminal', detail: 'PROVIDER_NOT_FOUND' };
        }

        throw error;
    }

    const providerStatus = providerLifecycleState.normalizeStatus('paypal',synced?.providerStatus || synced?.subscription?.status);

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

// An old (past the fast window) Plisio invoice that is still unresolved is rechecked once a day: record that it
// was just checked so it is not polled again until tomorrow.
async function markAgedChecked(row, state) {
    // Every unresolved row that was just checked goes to the back of the line (the queue is ordered by updated_at), which
    // also gates the once-a-day recheck of invoices past the fast window.
    if (state === 'recovered' || state === 'terminal') return;
    await query(`UPDATE billing_checkout_intents SET updated_at=NOW() WHERE id=$1`, [row.id]);
}

async function run({ limit = DEFAULT_LIMIT, handlers = null, checkoutIntentIds = null, ignoreLookback = false } = {}) {
    const rows = await candidates({ limit, checkoutIntentIds, ignoreLookback });
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
                : row.provider === 'plisio'
                    ? await recoverPlisio(row, activeHandlers)
                    : await recoverPayPal(row, activeHandlers);
            summary[result.state] = Number(summary[result.state] || 0) + 1;
            await markAgedChecked(row, result.state);
        } catch (error) {
            await markAgedChecked(row, 'failed').catch(() => {});
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
    PAYPAL_LOCALLY_ABANDONED,
    paypalResourceNotFound,
    clampLimit,
    failureWarning,
    candidates,
    recoverStripe,
    recoverPlisio,
    PLISIO_LOOKBACK_DAYS,
    PLISIO_AGED_LOOKBACK_DAYS,
    PLISIO_AGED_RECHECK_HOURS,
    PLISIO_FAILED_RETRY_HOURS,
    PLISIO_UNVERIFIED_ALERT_HOURS,
    PLISIO_UNPAID_GIVE_UP_HOURS,
    plisioUnpaidDeadlineHours,
    recoverPayPalPayment,
    recoverPayPal,
    run
};
