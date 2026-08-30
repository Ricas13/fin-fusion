'use strict';

const Stripe = require('stripe');
const { query } = require('../db');
const providerSettings = require('./provider-settings');
const { classifyProviderTransaction } = require('./provider-transaction-classifier');

const DEFAULT_HOURS = 72;
const MAX_HOURS = 24 * 14;

function sinceDate(hours = DEFAULT_HOURS) { const n = Math.max(1, Math.min(MAX_HOURS, Number(hours) || DEFAULT_HOURS)); return new Date(Date.now() - n * 60 * 60 * 1000); }
function iso(value) { return new Date(value).toISOString(); }
function providerLabel(provider) { return provider === 'paypal' ? 'PayPal' : 'Stripe'; }
function money(minor, currency) { const value = Number(minor); if (!Number.isFinite(value)) return '—'; try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: String(currency || 'USD').toUpperCase(), currencyDisplay: 'narrowSymbol' }).format(value / 100); } catch (_) { return `${String(currency || 'USD').toUpperCase()} ${(value / 100).toFixed(2)}`; } }
function paypalBase(config) { return config?.environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'; }

async function paypalToken(config) {
    if (!config?.clientId || !config?.clientSecret) throw new Error('PayPal is not configured');
    const response = await fetch(`${paypalBase(config)}/v1/oauth2/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: 'grant_type=client_credentials'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) throw new Error(`PayPal reporting authentication failed: ${payload.error_description || payload.message || response.status}`);
    return payload.access_token;
}

const MAX_PAYPAL_PAGES = 10;
const MAX_STRIPE_PAGES = 100;

async function paypalTransactionPage(config, token, since, end, page) {
    const params = new URLSearchParams({ start_date: iso(since), end_date: iso(end), fields: 'all', page_size: '100', page: String(page) });
    const response = await fetch(`${paypalBase(config)}/v1/reporting/transactions?${params}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`PayPal reporting failed: ${payload.message || response.status}`);
    return payload;
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
            amountMinor: amount.value != null ? Math.round(Number(amount.value) * 100) : null,
            currency: amount.currency_code || null, createdAt: info.transaction_initiation_date || info.transaction_updated_date || null,
            status, eventCode: info.transaction_event_code || null, email: detail.payer_info?.email_address || null, raw: detail
        };
    }).filter(row => row.id && classifyProviderTransaction({
        provider: 'paypal', type: row.eventCode, status: row.status, grossMinor: row.amountMinor
    }) === 'payment');
    return { provider: 'paypal', configured: true, rows, truncated };
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
        // Financial/provider failures are deliberately returned to the UI, not
        // converted into an apparently clean empty reconciliation result.
        return { provider, configured: true, error: error.message || String(error), rows: [] };
    }
}

async function recentUnmapped({ hours = DEFAULT_HOURS } = {}) {
    const since = sinceDate(hours), results = await Promise.all(['paypal', 'stripe'].map(provider => providerResult(provider, since)));
    const rows = results.flatMap(result => result.rows).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return { since, hours: Math.round((Date.now() - since.getTime()) / 3600000), results, rows };
}

module.exports = { DEFAULT_HOURS, MAX_HOURS, MAX_STRIPE_PAGES, recentUnmapped, paypalRecent, stripeRecent, stripeChargeRow, localMatch, money, providerLabel };