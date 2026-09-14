'use strict';

const Stripe = require('stripe');
const { query } = require('../db');
const providerSettings = require('./provider-settings');
const providerHttp = require('./provider-http');
const checkoutIntents = require('./checkout-intents');
const livePaypalHistory = require('./live-paypal-payment-history');
const { classifyProviderTransaction } = require('./provider-transaction-classifier');

const DEFAULT_HOURS = 72;
const MAX_HOURS = 24 * 14;

function sinceDate(hours = DEFAULT_HOURS) { const n = Math.max(1, Math.min(MAX_HOURS, Number(hours) || DEFAULT_HOURS)); return new Date(Date.now() - n * 60 * 60 * 1000); }
function iso(value) { return new Date(value).toISOString(); }
function providerLabel(provider) { return provider === 'paypal' ? 'PayPal' : 'Stripe'; }
function money(minor, currency) { const value = Number(minor); if (!Number.isFinite(value)) return '—'; try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: String(currency || 'USD').toUpperCase(), currencyDisplay: 'narrowSymbol' }).format(value / 100); } catch (_) { return `${String(currency || 'USD').toUpperCase()} ${(value / 100).toFixed(2)}`; } }
function paypalBase(config) { return config?.environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'; }
function paypalReportingError(response, payload, requestId, fallback) { return providerHttp.responseError('paypal', response, payload, requestId, fallback); }

let cachedPaypalReportingToken = null;
let cachedPaypalReportingTokenUntil = 0;
let cachedPaypalReportingCredentialKey = null;
async function paypalToken(config) {
    if (!config?.clientId || !config?.clientSecret) throw new Error('PayPal is not configured');
    const credentialKey = `${config.environment || 'sandbox'}:${config.clientId}:${config.clientSecret}`;
    if (cachedPaypalReportingCredentialKey !== credentialKey) {
        cachedPaypalReportingToken = null;
        cachedPaypalReportingTokenUntil = 0;
        cachedPaypalReportingCredentialKey = credentialKey;
    }
    if (cachedPaypalReportingToken && Date.now() < cachedPaypalReportingTokenUntil - 60000) return cachedPaypalReportingToken;
    const result = await providerHttp.fetchJson('paypal', `${paypalBase(config)}/v1/oauth2/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: 'grant_type=client_credentials'
    });
    const payload = result.data || {};
    if (!result.response.ok || !payload.access_token) throw paypalReportingError(result.response, payload, result.requestId, 'PayPal reporting authentication failed');
    cachedPaypalReportingToken = payload.access_token;
    cachedPaypalReportingTokenUntil = Date.now() + Math.max(60, Number(payload.expires_in) || 300) * 1000;
    return cachedPaypalReportingToken;
}

const MAX_PAYPAL_PAGES = 10;
const MAX_STRIPE_PAGES = 100;
const PAYPAL_CAPTURE_LOOKUP_CONCURRENCY = 8;
const PAYPAL_UNMATCHED_RECHECK_MS = 6 * 60 * 60 * 1000;
const paypalUnmatchedSeenAt = new Map();

async function paypalTransactionPage(config, token, since, end, page) {
    const params = new URLSearchParams({ start_date: iso(since), end_date: iso(end), fields: 'all', page_size: '100', page: String(page) });
    const result = await providerHttp.fetchJson('paypal', `${paypalBase(config)}/v1/reporting/transactions?${params}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    });
    const payload = result.data || {};
    if (!result.response.ok) throw paypalReportingError(result.response, payload, result.requestId, 'PayPal reporting failed');
    return payload;
}

async function paypalCapture(config, token, captureId) {
    const result = await providerHttp.fetchJson('paypal', `${paypalBase(config)}/v2/payments/captures/${encodeURIComponent(captureId)}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    });
    const payload = result.data || {};
    if (!result.response.ok) throw paypalReportingError(result.response, payload, result.requestId, `PayPal capture lookup failed for ${captureId}`);
    return payload;
}

function paypalCaptureOrderId(capture) {
    const ids = capture?.supplementary_data?.related_ids || capture?.related_ids || {};
    return ids.order_id ? String(ids.order_id).trim() || null : null;
}

function paypalOrderReference(row) {
    if (String(row?.referenceType || '').trim().toUpperCase() !== 'ODR') return null;
    const id = String(row?.referenceId || '').trim();
    return id || null;
}

async function paypalRecent(since) {
    const config = await providerSettings.get('paypal');
    if (!config?.clientId || !config?.clientSecret) return { provider: 'paypal', configured: false, rows: [] };
    const token = await paypalToken(config), end = new Date();
    const details = [];
    let page = 1, totalPages = 1, truncated = false;
    while (page <= totalPages) {
        const payload = await paypalTransactionPage(config, token, since, end, page);
        details.push(...(payload.transaction_details || []));
        totalPages = Math.max(1, Number(payload.total_pages) || 1);
        if (page >= MAX_PAYPAL_PAGES && page < totalPages) { truncated = true; break; }
        page += 1;
    }
    const rows = details.map(detail => {
        const info = detail.transaction_info || {}, amount = info.transaction_amount || {}, status = String(info.transaction_status || '');
        const referenceId = info.paypal_reference_id || null, referenceType = info.paypal_reference_id_type || null;
        return {
            provider: 'paypal', id: info.transaction_id || null, referenceId, referenceType,
            invoiceId: info.invoice_id || null, customId: info.custom_field || null,
            amountMinor: livePaypalHistory.moneyMinor(amount),
            currency: amount.currency_code || null, createdAt: info.transaction_initiation_date || info.transaction_updated_date || null,
            status, eventCode: info.transaction_event_code || null, email: detail.payer_info?.email_address || null, raw: detail
        };
    }).filter(row => row.id && classifyProviderTransaction({
        provider: 'paypal', type: row.eventCode, status: row.status, grossMinor: row.amountMinor
    }) === 'payment');
    return { provider: 'paypal', configured: true, rows, truncated };
}

async function authoritativePayPalCaptureIds(ids) {
    if (!ids.length) return new Set();
    const result = await query(`
        SELECT provider_transaction_id,transaction_type,transaction_status,gross_amount_minor,customer_id,metadata
        FROM payment_history_transactions
        WHERE provider='paypal'
          AND provider_transaction_id = ANY($1::text[])
          AND customer_id IS NOT NULL
          AND metadata->>'providerAuthoritative'='true'
          AND metadata->>'feeDataAvailable'='true'
    `, [ids]);
    return new Set(result.rows.filter(row => classifyProviderTransaction({
        provider: 'paypal',
        type: row.transaction_type,
        status: row.transaction_status,
        grossMinor: row.gross_amount_minor
    }) === 'payment').map(row => String(row.provider_transaction_id)));
}

function checkoutIndex(rows) {
    const indexed = new Map();
    for (const row of rows || []) {
        const key = String(row.provider_checkout_id || '');
        if (!key || !row.customer_id || indexed.has(key)) continue;
        indexed.set(key, row);
    }
    return indexed;
}

function paypalCandidateHasLocalEvidence(row, byCapture, byCheckout) {
    const captureId = String(row?.id || '');
    const orderId = paypalOrderReference(row);
    return Boolean(byCapture?.has(captureId) || (orderId && byCheckout?.has(orderId)));
}

function prioritizePayPalCandidates(rows, byCapture, byCheckout) {
    return (rows || []).map((row, index) => ({
        row,
        index,
        localEvidence: paypalCandidateHasLocalEvidence(row, byCapture, byCheckout)
    })).sort((a, b) => Number(b.localEvidence) - Number(a.localEvidence) || a.index - b.index).map(item => item.row);
}

function pruneUnmatchedPayPalCooldowns(now = Date.now()) {
    for (const [id, seenAt] of paypalUnmatchedSeenAt) {
        if (!Number.isFinite(seenAt) || now - seenAt >= PAYPAL_UNMATCHED_RECHECK_MS) paypalUnmatchedSeenAt.delete(id);
    }
}

function paypalUnmatchedCoolingDown(row, byCapture, byCheckout, now = Date.now()) {
    if (paypalCandidateHasLocalEvidence(row, byCapture, byCheckout)) return false;
    const captureId = String(row?.id || '');
    if (!captureId) return false;
    const seenAt = Number(paypalUnmatchedSeenAt.get(captureId));
    if (!Number.isFinite(seenAt)) return false;
    if (now - seenAt >= PAYPAL_UNMATCHED_RECHECK_MS) {
        paypalUnmatchedSeenAt.delete(captureId);
        return false;
    }
    return true;
}

function rememberUnmatchedPayPalCapture(captureId, now = Date.now()) {
    const id = String(captureId || '').trim();
    if (!id) return;
    pruneUnmatchedPayPalCooldowns(now);
    paypalUnmatchedSeenAt.set(id, now);
}

function clearUnmatchedPayPalCapture(captureId) {
    const id = String(captureId || '').trim();
    if (id) paypalUnmatchedSeenAt.delete(id);
}

async function forEachConcurrent(rows, concurrency, worker) {
    let next = 0;
    const width = Math.max(1, Math.min(Number(concurrency) || 1, rows.length || 1));
    await Promise.all(Array.from({ length: width }, async () => {
        while (true) {
            const index = next;
            next += 1;
            if (index >= rows.length) return;
            await worker(rows[index], index);
        }
    }));
}

async function syncRecentPayPalHistory({ hours = DEFAULT_HOURS, limit = 500 } = {}) {
    const since = sinceDate(hours);
    const remote = await paypalRecent(since);
    if (!remote.configured) return { provider: 'paypal', configured: false, processed: 0, recorded: 0, alreadyAuthoritative: 0, skipped: 0, fulfillmentPending: 0, deferredUnmatched: 0, truncated: false };

    const allCandidates = remote.rows.filter(row => row.eventCode === livePaypalHistory.LIVE_CAPTURE_PAYMENT_TYPE);
    const allCandidateIds = allCandidates.map(row => String(row.id));
    const authoritativeIds = await authoritativePayPalCaptureIds(allCandidateIds);
    const allPending = allCandidates.filter(row => !authoritativeIds.has(String(row.id)));
    const alreadyAuthoritative = allCandidates.length - allPending.length;
    if (!allPending.length) {
        return {
            provider: 'paypal', configured: true, processed: 0, recorded: 0, alreadyAuthoritative, skipped: 0, fulfillmentPending: 0, deferredUnmatched: 0,
            truncated: Boolean(remote.truncated), warning: remote.truncated ? 'PayPal reconciliation results were truncated; not every recent provider payment was inspected.' : null
        };
    }

    // Rank before applying the provider-call budget. A shared/busy PayPal account can
    // otherwise keep unrelated captures permanently ahead of a Fin-Fusion capture
    // that already has local subscription or checkout ownership evidence.
    const pendingIds = allPending.map(row => String(row.id));
    const mapped = await query(`
        SELECT provider_subscription_id,customer_id,provider_customer_id
        FROM subscriptions
        WHERE source='paypal' AND provider_subscription_id = ANY($1::text[])
        ORDER BY created_at DESC
    `, [pendingIds]);
    const byCapture = new Map();
    for (const row of mapped.rows) {
        const key = String(row.provider_subscription_id || '');
        if (!key || byCapture.has(key)) continue;
        byCapture.set(key, row);
    }

    // paypal_reference_id can identify several different PayPal object types.
    // Only ODR is an order ID and therefore safe to match to provider_checkout_id.
    const reportedOrderIds = [...new Set(allPending.map(paypalOrderReference).filter(Boolean))];
    const reportedIntents = reportedOrderIds.length ? await query(`
        SELECT provider_checkout_id,customer_id
        FROM billing_checkout_intents
        WHERE provider='paypal' AND provider_checkout_id = ANY($1::text[])
        ORDER BY created_at DESC
    `, [reportedOrderIds]) : { rows: [] };
    const byCheckout = checkoutIndex(reportedIntents.rows);

    const boundedLimit = Math.max(1, Math.min(1000, Number(limit) || 500));
    const prioritizedPending = prioritizePayPalCandidates(allPending, byCapture, byCheckout);
    const eligiblePending = prioritizedPending.filter(row => !paypalUnmatchedCoolingDown(row, byCapture, byCheckout));
    const deferredUnmatched = prioritizedPending.length - eligiblePending.length;
    const candidates = eligiblePending.slice(0, boundedLimit);
    const limited = eligiblePending.length > candidates.length;
    const truncated = Boolean(remote.truncated || limited);
    if (!candidates.length) {
        return {
            provider: 'paypal', configured: true, processed: 0, recorded: 0, alreadyAuthoritative, skipped: 0, fulfillmentPending: 0, deferredUnmatched,
            truncated, warning: truncated ? 'PayPal reconciliation results were truncated; not every recent provider payment was inspected.' : null
        };
    }

    const config = await providerSettings.get('paypal');
    const token = await paypalToken(config);
    const captures = new Map();
    const failures = [];
    await forEachConcurrent(candidates, PAYPAL_CAPTURE_LOOKUP_CONCURRENCY, async row => {
        try {
            const capture = await paypalCapture(config, token, row.id);
            captures.set(String(row.id), capture);
        } catch (error) {
            failures.push({ id: row.id, error: error.message || String(error) });
        }
    });

    // Transaction Search usually exposes the order reference, but the capture is
    // authoritative. Merge any canonical order IDs discovered from the full capture
    // before deciding that a payment has no local checkout owner.
    const canonicalOrderIds = [...new Set([...captures.values()].map(paypalCaptureOrderId).filter(Boolean))];
    const missingOrderIds = canonicalOrderIds.filter(id => !byCheckout.has(String(id)));
    const canonicalIntents = missingOrderIds.length ? await query(`
        SELECT provider_checkout_id,customer_id
        FROM billing_checkout_intents
        WHERE provider='paypal' AND provider_checkout_id = ANY($1::text[])
        ORDER BY created_at DESC
    `, [missingOrderIds]) : { rows: [] };
    for (const [key, row] of checkoutIndex(canonicalIntents.rows)) byCheckout.set(key, row);

    let recorded = 0, skipped = 0, fulfillmentPending = 0;
    const skippedIds = [];
    const fulfillmentPendingIds = [];
    for (const row of candidates) {
        const capture = captures.get(String(row.id));
        if (!capture) continue;
        const canonicalOrderId = paypalCaptureOrderId(capture);
        const checkoutReference = canonicalOrderId || paypalOrderReference(row);
        const checkout = checkoutReference ? byCheckout.get(checkoutReference) || null : null;
        const subscription = byCapture.get(String(row.id)) || null;
        const local = subscription || checkout;
        if (!local?.customer_id) {
            skipped += 1;
            skippedIds.push(String(row.id));
            rememberUnmatchedPayPalCapture(row.id);
            continue;
        }
        try {
            await livePaypalHistory.assertCaptureOwner(row.id, local.customer_id);
            if (!subscription && checkout) {
                const amount = capture?.amount || capture?.seller_receivable_breakdown?.gross_amount || {};
                await checkoutIntents.verifiedProviderContract({
                    provider: 'paypal',
                    providerCheckoutId: checkoutReference,
                    scope: 'customer',
                    ownerId: local.customer_id,
                    checkoutMode: 'payment',
                    amountMinor: livePaypalHistory.moneyMinor(amount),
                    currency: livePaypalHistory.moneyCurrency(amount)
                });
            }
            await livePaypalHistory.recordCapture(capture, {
                customerId: local.customer_id,
                providerCustomerId: local.provider_customer_id || null,
                reconciliation: true
            });
            clearUnmatchedPayPalCapture(row.id);
            recorded += 1;
            if (!subscription && checkout) {
                fulfillmentPending += 1;
                fulfillmentPendingIds.push(String(row.id));
            }
        } catch (error) {
            failures.push({ id: row.id, error: error.message || String(error) });
        }
    }
    if (failures.length) {
        const error = new Error(`PayPal payment-history reconciliation failed for ${failures.length} capture(s): ${failures.slice(0, 3).map(item => `${item.id}: ${item.error}`).join('; ')}`);
        error.failures = failures;
        throw error;
    }
    const warningParts = [];
    if (skipped) warningParts.push(`${skipped} successful PayPal capture${skipped === 1 ? '' : 's'} could not be matched to a local customer and were not booked.`);
    if (fulfillmentPending) warningParts.push(`${fulfillmentPending} paid PayPal checkout${fulfillmentPending === 1 ? '' : 's'} matched a customer but has no capture-linked local purchase; accounting was repaired without changing fulfillment state.`);
    if (truncated) warningParts.push('PayPal reconciliation results were truncated; not every recent provider payment was inspected.');
    return {
        provider: 'paypal', configured: true, processed: candidates.length, recorded, alreadyAuthoritative, skipped, skippedIds,
        fulfillmentPending, fulfillmentPendingIds, deferredUnmatched,
        truncated, warning: warningParts.length ? warningParts.join(' ') : null
    };
}

function stripeChargeRow(charge) {
    if (!charge.paid || charge.refunded || classifyProviderTransaction({ provider: 'stripe', type: 'charge', status: charge.status, grossMinor: charge.amount }) !== 'payment') return null;
    let subscriptionId = null, invoice = charge.invoice || null;
    if (invoice && typeof invoice === 'object') {
        const sub = invoice.parent?.subscription_details?.subscription;
        subscriptionId = typeof sub === 'string' ? sub : sub?.id || null;
    }
    return {
        provider: 'stripe', id: charge.id,
        referenceId: typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id || null,
        subscriptionId, invoiceId: typeof invoice === 'string' ? invoice : invoice?.id || null,
        checkoutIntentId: charge.metadata?.internal_checkout_intent_id || null,
        customerId: charge.metadata?.internal_customer_id || null, planId: charge.metadata?.internal_plan_id || null,
        amountMinor: Number(charge.amount || 0), currency: String(charge.currency || '').toUpperCase(),
        createdAt: charge.created ? new Date(charge.created * 1000) : null, status: charge.status || 'succeeded',
        email: charge.billing_details?.email || null, raw: charge
    };
}

async function stripeRecent(since) {
    const config = await providerSettings.get('stripe'), key = config?.restrictedKey || config?.apiKey || '';
    if (!key) return { provider: 'stripe', configured: false, rows: [] };
    const stripe = new Stripe(key, { apiVersion: '2026-06-24.dahlia', appInfo: { name: 'CAPTAiNFiN', version: '1.0.0' } });
    const rows = [];
    let startingAfter = null, pages = 0, truncated = false;
    while (true) {
        const charges = await stripe.charges.list({ limit: 100, created: { gte: Math.floor(since.getTime() / 1000) }, expand: ['data.invoice'], ...(startingAfter ? { starting_after: startingAfter } : {}) });
        for (const charge of charges.data || []) {
            const row = stripeChargeRow(charge);
            if (row) rows.push(row);
        }
        pages += 1;
        if (!charges.has_more) break;
        if (pages >= MAX_STRIPE_PAGES) { truncated = true; break; }
        const last = (charges.data || [])[charges.data.length - 1];
        if (!last?.id) throw new Error('Stripe reconciliation pagination did not return a continuation ID.');
        startingAfter = last.id;
    }
    return { provider: 'stripe', configured: true, rows, truncated };
}

function collectIds(row) { return new Set([row.id, row.referenceId, row.subscriptionId, row.invoiceId, row.checkoutIntentId].filter(Boolean).map(String)); }
function payloadContains(event, ids) { if (!event?.payload || !ids.size) return false; let body = ''; try { body = JSON.stringify(event.payload); } catch (_) { return false; } for (const id of ids) if (body.includes(id)) return true; return false; }
function localMatch(row, local) {
    const ids = collectIds(row);
    const intent = local.intents.find(item => (row.checkoutIntentId && String(item.id) === String(row.checkoutIntentId)) || (item.provider_checkout_id && ids.has(String(item.provider_checkout_id)))) || null;
    const subscription = local.subscriptions.find(item => item.provider_subscription_id && ids.has(String(item.provider_subscription_id))) || null;
    const sameCustomerPlan = !subscription && row.customerId && row.planId
        ? local.subscriptions.find(item => String(item.customer_id) === String(row.customerId) && String(item.plan_id) === String(row.planId)) || null
        : null;
    const event = local.events.find(item => payloadContains(item, ids)) || null;
    let reason = null, severity = 'warn';
    if (event?.processing_error) { reason = `Webhook recorded but processing failed: ${event.processing_error}`; severity = 'bad'; }
    else if (intent && intent.state !== 'completed') { reason = `Checkout exists locally but is ${intent.state}; provider reports the payment succeeded.`; severity = 'bad'; }
    else if (intent && !subscription) { reason = 'Checkout completed locally but no provider-reference-matching subscription/purchase record was found.'; severity = 'bad'; }
    else if (!intent && !subscription && !event && sameCustomerPlan) { reason = 'A local subscription exists for the same customer and plan, but its provider reference does not match this payment.'; severity = 'bad'; }
    else if (!intent && !subscription && !event) reason = 'No matching checkout, subscription, or webhook event exists locally.';
    else if (!subscription && event) { reason = 'Provider event exists locally but no provider-reference-matching customer purchase was found.'; severity = 'bad'; }
    return { intent, subscription, event, reason, severity };
}

async function localRows(provider, since) {
    const [intents, subscriptions, events] = await Promise.all([
        query(`SELECT id,customer_id,plan_id,provider_checkout_id,state,created_at,completed_at,commercial_snapshot FROM billing_checkout_intents WHERE provider=$1 AND created_at>=$2 ORDER BY created_at DESC`, [provider, since]),
        query(`SELECT id,customer_id,plan_id,provider_subscription_id,status,created_at,current_period_end FROM subscriptions WHERE source=$1 ORDER BY created_at DESC`, [provider]),
        query(`SELECT provider_event_id AS event_id,event_type,payload,processed_at,processing_error,created_at FROM payment_events WHERE provider=$1 AND created_at>=$2 ORDER BY created_at DESC`, [provider, since])
    ]);
    return { intents: intents.rows, subscriptions: subscriptions.rows, events: events.rows };
}

async function providerResult(provider, since) {
    try {
        const remote = provider === 'paypal' ? await paypalRecent(since) : await stripeRecent(since);
        if (!remote.configured) return { provider, configured: false, error: null, rows: [] };
        const local = await localRows(provider, since), rows = remote.rows.map(row => ({ ...row, ...localMatch(row, local) })).filter(row => row.reason);
        return { provider, configured: true, error: null, rows, truncated: Boolean(remote.truncated) };
    } catch (error) {
        return { provider, configured: true, error: error.message || String(error), rows: [] };
    }
}

async function recentUnmapped({ hours = DEFAULT_HOURS } = {}) {
    const since = sinceDate(hours), results = await Promise.all(['paypal', 'stripe'].map(provider => providerResult(provider, since)));
    const rows = results.flatMap(result => result.rows).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return { since, hours: Math.round((Date.now() - since.getTime()) / 3600000), results, rows };
}

module.exports = {
    DEFAULT_HOURS,
    MAX_HOURS,
    MAX_PAYPAL_PAGES,
    MAX_STRIPE_PAGES,
    PAYPAL_CAPTURE_LOOKUP_CONCURRENCY,
    PAYPAL_UNMATCHED_RECHECK_MS,
    recentUnmapped,
    paypalRecent,
    paypalCapture,
    paypalCaptureOrderId,
    paypalOrderReference,
    authoritativePayPalCaptureIds,
    paypalCandidateHasLocalEvidence,
    prioritizePayPalCandidates,
    paypalUnmatchedCoolingDown,
    rememberUnmatchedPayPalCapture,
    clearUnmatchedPayPalCapture,
    forEachConcurrent,
    syncRecentPayPalHistory,
    stripeRecent,
    stripeChargeRow,
    localMatch,
    money,
    providerLabel
};
