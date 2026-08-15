'use strict';

const Stripe = require('stripe');
const core = require('./reseller-billing-core');
const providerSettings = require('./provider-settings');
const intents = require('./checkout-intents');
const monthly = require('../resellers/monthly');
const { query } = require('../db');

function withState(url, intent) {
    const target = new URL(url);
    target.searchParams.set('checkout_intent', intent.id);
    target.searchParams.set('checkout_state', intent.nonce);
    return target.toString();
}

async function createStripeCheckout(input) {
    const intent = await intents.createIntent({
        scope: 'reseller', resellerId: input.resellerId, tierId: input.tierId,
        provider: 'stripe', checkoutMode: 'subscription'
    });
    try {
        const checkout = await core.createStripeCheckout({ ...input, successUrl: withState(input.successUrl, intent) });
        await intents.attachProviderCheckout(intent.id, checkout.id);
        return { ...checkout, intentId: intent.id, state: intent.nonce };
    } catch (error) {
        await intents.consume({ intentId: intent.id, nonce: intent.nonce, state: 'failed' }).catch(() => {});
        throw error;
    }
}

async function createPayPalCheckout(input) {
    const intent = await intents.createIntent({
        scope: 'reseller', resellerId: input.resellerId, tierId: input.tierId,
        provider: 'paypal', checkoutMode: 'subscription'
    });
    try {
        const checkout = await core.createPayPalCheckout({ ...input, returnUrl: withState(input.returnUrl, intent) });
        await intents.attachProviderCheckout(intent.id, checkout.id);
        return { ...checkout, intentId: intent.id, state: intent.nonce };
    } catch (error) {
        await intents.consume({ intentId: intent.id, nonce: intent.nonce, state: 'failed' }).catch(() => {});
        throw error;
    }
}

async function activatePayPalCheckout({ subscriptionId, intentId, state }) {
    const consumed = await intents.consume({ intentId, nonce: state, providerCheckoutId: subscriptionId, state: 'completed' });
    if (consumed.scope !== 'reseller') throw new Error('Checkout intent does not belong to reseller billing.');
    const result = await core.activatePayPalSubscription(subscriptionId);
    if (String(result?.reseller_id || consumed.reseller_id) !== String(consumed.reseller_id)) throw new Error('PayPal subscription does not match the reseller checkout.');
    return result;
}

function parsedBody(raw) {
    try { return JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '{}')); }
    catch (_) { return {}; }
}

async function processStripeWebhook(rawBody, signature) {
    const result = await core.processStripeWebhook(rawBody, signature);
    const event = parsedBody(rawBody);
    const object = event?.data?.object || {};
    if (event.type === 'checkout.session.completed' && object.id) {
        await intents.completeVerifiedProvider('stripe', object.id, 'completed').catch(() => {});
    } else if (event.type === 'checkout.session.expired' && object.id) {
        await intents.completeVerifiedProvider('stripe', object.id, 'cancelled').catch(() => {});
    }
    return result;
}

async function processPayPalWebhook(rawBody, headers) {
    const result = await core.processPayPalWebhook(rawBody, headers);
    const event = parsedBody(rawBody);
    const resource = event?.resource || {};
    const providerId = resource.id || resource.billing_agreement_id || '';
    if (providerId && ['BILLING.SUBSCRIPTION.ACTIVATED','PAYMENT.SALE.COMPLETED'].includes(event.event_type)) {
        await intents.completeVerifiedProvider('paypal', providerId, 'completed').catch(() => {});
    }
    if (event.event_type === 'PAYMENT.SALE.REFUNDED' && resource.billing_agreement_id) {
        // Refunds are accounting events. Preserve already-paid access by default;
        // a chargeback/refund policy can explicitly revoke it later.
        await query(`UPDATE reseller_subscriptions SET status='active',updated_at=NOW()
            WHERE source='paypal' AND provider_subscription_id=$1 AND current_period_end>NOW()`, [resource.billing_agreement_id]);
        await query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata)
            SELECT 'reseller.payment.refund','reseller',reseller_id,$2::jsonb FROM reseller_subscriptions
            WHERE source='paypal' AND provider_subscription_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [resource.billing_agreement_id, JSON.stringify({ provider: 'paypal', eventId: event.id, policy: 'preserve_paid_through' })]);
    }
    return result;
}

async function stripeClient() {
    const cfg = await providerSettings.get('stripe');
    const key = cfg.restrictedKey || cfg.apiKey || '';
    if (!key) throw new Error('Stripe is disabled or not configured.');
    return new Stripe(key, { apiVersion: '2026-06-24.dahlia', appInfo: { name: 'CAPTaINFiN', version: '1.3.0' } });
}

function paypalBase(cfg) { return cfg.environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'; }
async function paypalToken() {
    const cfg = await providerSettings.get('paypal');
    if (!cfg.clientId || !cfg.clientSecret) throw new Error('PayPal is disabled or not configured.');
    const response = await fetch(`${paypalBase(cfg)}/v1/oauth2/token`, {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: 'grant_type=client_credentials'
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) throw new Error(body.error_description || `PayPal HTTP ${response.status}`);
    return { cfg, token: body.access_token };
}
async function paypalGet(path) {
    const { cfg, token } = await paypalToken();
    const response = await fetch(`${paypalBase(cfg)}${path}`, { redirect: 'error', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || `PayPal HTTP ${response.status}`);
    return body;
}

async function validateTierMapping(tierId, provider) {
    const mapping = await monthly.providerMapping(tierId, provider);
    if (!mapping) throw new Error(`No active ${provider} mapping exists for this tier.`);
    if (provider === 'stripe') {
        const client = await stripeClient();
        const price = await client.prices.retrieve(mapping.external_id);
        const problems = [];
        if (!price.active) problems.push('price is inactive');
        if (price.type !== 'recurring' || price.recurring?.interval !== 'month' || Number(price.recurring?.interval_count || 1) !== 1) problems.push('price is not monthly recurring');
        if (String(price.currency || '').toUpperCase() !== String(mapping.currency || '').trim().toUpperCase()) problems.push(`currency is ${price.currency}`);
        if (Number(price.unit_amount) !== Number(mapping.monthly_price_minor)) problems.push(`amount is ${price.unit_amount}`);
        if (problems.length) throw new Error(`Stripe mapping mismatch: ${problems.join('; ')}.`);
        return { ok: true, provider, externalId: mapping.external_id, amountMinor: price.unit_amount, currency: String(price.currency).toUpperCase(), interval: 'month' };
    }
    const plan = await paypalGet(`/v1/billing/plans/${encodeURIComponent(mapping.external_id)}`);
    const regular = (plan.billing_cycles || []).find(cycle => cycle.tenure_type === 'REGULAR') || (plan.billing_cycles || [])[0];
    const fixed = regular?.pricing_scheme?.fixed_price;
    const problems = [];
    if (plan.status !== 'ACTIVE') problems.push(`plan status is ${plan.status || 'unknown'}`);
    if (regular?.frequency?.interval_unit !== 'MONTH' || Number(regular?.frequency?.interval_count || 1) !== 1) problems.push('plan is not monthly recurring');
    if (fixed?.currency_code && String(fixed.currency_code).toUpperCase() !== String(mapping.currency).trim().toUpperCase()) problems.push(`currency is ${fixed.currency_code}`);
    if (fixed?.value && Math.round(Number(fixed.value) * 100) !== Number(mapping.monthly_price_minor)) problems.push(`amount is ${fixed.value}`);
    if (problems.length) throw new Error(`PayPal mapping mismatch: ${problems.join('; ')}.`);
    return { ok: true, provider, externalId: mapping.external_id, amountMinor: fixed?.value ? Math.round(Number(fixed.value) * 100) : null, currency: fixed?.currency_code || mapping.currency, interval: 'month' };
}

async function changeStripeTier(resellerId, tierId, { proration = true } = {}) {
    const current = await monthly.currentSubscription(resellerId);
    if (!current || current.source !== 'stripe' || !current.provider_subscription_id) throw new Error('An active Stripe reseller subscription is required for an immediate tier change.');
    await validateTierMapping(tierId, 'stripe');
    const mapping = await monthly.providerMapping(tierId, 'stripe');
    const client = await stripeClient();
    const remote = await client.subscriptions.retrieve(current.provider_subscription_id);
    const item = remote.items?.data?.[0];
    if (!item?.id) throw new Error('Stripe subscription has no editable subscription item.');
    await client.subscriptions.update(current.provider_subscription_id, {
        items: [{ id: item.id, price: mapping.external_id }],
        proration_behavior: proration ? 'create_prorations' : 'none',
        metadata: { ...(remote.metadata || {}), billing_scope: 'reseller', internal_reseller_id: resellerId, internal_reseller_tier_id: tierId }
    });
    const synced = await core.syncStripeSubscription(current.provider_subscription_id);
    await query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('reseller.tier.change','reseller',$1,$2::jsonb)`,
        [resellerId, JSON.stringify({ fromTierId: current.tier_id, toTierId: tierId, provider: 'stripe', proration })]);
    return synced;
}

async function resumeRenewal(resellerId) {
    const current = await monthly.currentSubscription(resellerId);
    if (!current || !current.provider_subscription_id) throw new Error('No provider subscription is available to resume.');
    if (current.source !== 'stripe') throw new Error('Cancelled PayPal subscriptions cannot be resumed automatically. Start a new PayPal subscription after the paid-through period.');
    const client = await stripeClient();
    await client.subscriptions.update(current.provider_subscription_id, { cancel_at_period_end: false });
    return core.syncStripeSubscription(current.provider_subscription_id);
}

module.exports = {
    ...core,
    createStripeCheckout,
    createPayPalCheckout,
    activatePayPalCheckout,
    processStripeWebhook,
    processPayPalWebhook,
    validateTierMapping,
    changeStripeTier,
    resumeRenewal
};
