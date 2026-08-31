'use strict';

const Stripe = require('stripe');
const { query } = require('../db');
const providerSettings = require('./provider-settings');
const providerHttp = require('./provider-http');
const discovery = require('./subscription-discovery');
const lifecycle = require('./lifecycle');

function clean(value, max = 500) { return String(value == null ? '' : value).trim().slice(0, max); }
function emailKey(value) { return clean(value, 320).toLowerCase(); }
function providerLabel(value) { return value === 'stripe' ? 'Stripe' : value === 'paypal' ? 'PayPal' : value; }

async function localPremium(subscriptionId) {
    const rows = await discovery.premiumEntitlements();
    const local = rows.find(row => String(row.subscription_id) === String(subscriptionId));
    if (!local) throw new Error('This subscription is no longer an active paid Premium Server entitlement.');
    if (discovery.recurringId(local.source, local.provider_subscription_id)) throw new Error('This subscription is already linked to a recurring provider subscription.');
    return local;
}

function stripeLookupError(error) {
    const status = Number(error?.statusCode || error?.status || error?.raw?.statusCode || 0);
    const detail = clean(error?.raw?.message || error?.message || error?.raw?.error?.message || 'request failed', 900);
    return new Error(`Stripe subscription lookup failed${status ? ` (${status})` : ''}: ${detail}`);
}

async function stripeRemote(providerSubscriptionId) {
    if (!/^sub_/i.test(providerSubscriptionId)) throw new Error('Stripe recurring subscription IDs must start with sub_.');
    const cfg = await providerSettings.getRaw('stripe');
    const key = cfg.restrictedKey || cfg.apiKey || '';
    if (!key) throw new Error('Stripe credentials are not configured.');
    const stripe = new Stripe(key, {
        apiVersion: '2026-06-24.dahlia',
        appInfo: { name: 'CAPTAiNFiN', version: '1.0.0' },
        maxNetworkRetries: 2,
        timeout: providerHttp.timeoutMs('stripe')
    });

    let subscription;
    try {
        // The subscription itself is authoritative. Do not require the restricted
        // key to have Customers-read permission just to verify an imported link.
        // Customer email is enrichment and is fetched separately on a best-effort
        // basis; provider customer ID remains available on the subscription.
        subscription = await stripe.subscriptions.retrieve(providerSubscriptionId, { expand: ['items.data.price'] });
    } catch (error) {
        throw stripeLookupError(error);
    }

    let customer = subscription?.customer && typeof subscription.customer === 'object' ? subscription.customer : null;
    const customerId = typeof subscription?.customer === 'string' ? subscription.customer : subscription?.customer?.id;
    if (!customer && customerId) {
        try {
            const fetched = await stripe.customers.retrieve(customerId);
            if (fetched && !fetched.deleted) customer = fetched;
        } catch (_) {
            // A restricted key can legitimately read subscriptions without being
            // allowed to read Customers. Manual recovery remains safe because the
            // operator must explicitly confirm ownership when identity enrichment
            // is unavailable.
        }
    }
    return discovery.normalizeStripeSubscription(subscription, customer);
}

function paypalHost(cfg) { return cfg.environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'; }
async function paypalToken(cfg) {
    if (!cfg.clientId || !cfg.clientSecret) throw new Error('PayPal credentials are not configured.');
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    const result = await providerHttp.fetchJson('paypal', `${paypalHost(cfg)}/v1/oauth2/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials'
    });
    if (!result.response.ok || !result.data?.access_token) {
        const detail = result.data?.error_description || result.data?.message || `HTTP ${result.response.status}`;
        throw new Error(`PayPal OAuth failed: ${detail}`);
    }
    return result.data.access_token;
}
function normalizeLegacyPayPalAgreement(agreement) {
    const next = agreement?.agreement_details?.next_billing_date ? new Date(agreement.agreement_details.next_billing_date) : null;
    return {
        provider: 'paypal',
        id: clean(agreement?.id, 255),
        providerCustomerId: clean(agreement?.payer?.payer_info?.payer_id, 255) || null,
        email: clean(agreement?.payer?.payer_info?.email, 320) || null,
        status: clean(agreement?.state, 60).toUpperCase(),
        periodEnd: next && !Number.isNaN(next.getTime()) ? next : null,
        cancelAtPeriodEnd: ['CANCELLED', 'CANCELED', 'EXPIRED'].includes(clean(agreement?.state, 60).toUpperCase()),
        externalPlanIds: clean(agreement?.plan?.id, 255) ? [clean(agreement.plan.id, 255)] : [],
        apiFamily: 'billing-agreements-v1'
    };
}
async function paypalRead(cfg, token, path) {
    return providerHttp.fetchJson('paypal', `${paypalHost(cfg)}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'PayPal-Enforce-ISO8601-Format': 'true' }
    });
}
async function paypalRemote(providerSubscriptionId) {
    if (!/^I-/i.test(providerSubscriptionId)) throw new Error('PayPal recurring subscription IDs must start with I-.');
    const cfg = await providerSettings.getRaw('paypal');
    const token = await paypalToken(cfg);

    const modern = await paypalRead(cfg, token, `/v1/billing/subscriptions/${encodeURIComponent(providerSubscriptionId)}?fields=plan`);
    if (modern.response.ok) return discovery.normalizePayPalSubscription(modern.data || {});

    // Migrated subscriptions can pre-date PayPal's current Subscriptions API. Those
    // I- profile IDs are exposed through the deprecated Billing Agreements v1 API.
    // Try that API only when the current subscription endpoint says the resource is
    // absent/invalid; do not hide authentication, permission or provider outages.
    if ([404, 422].includes(Number(modern.response.status))) {
        const legacy = await paypalRead(cfg, token, `/v1/payments/billing-agreements/${encodeURIComponent(providerSubscriptionId)}`);
        if (legacy.response.ok) return normalizeLegacyPayPalAgreement(legacy.data || {});
        const legacyDetail = legacy.data?.message || legacy.data?.name || `HTTP ${legacy.response.status}`;
        const modernDetail = modern.data?.message || modern.data?.name || `HTTP ${modern.response.status}`;
        throw new Error(`PayPal could not read this recurring profile through either Subscriptions v1 (${modernDetail}) or legacy Billing Agreements v1 (${legacyDetail}).`);
    }

    const detail = modern.data?.message || modern.data?.name || `HTTP ${modern.response.status}`;
    throw new Error(`PayPal subscription lookup failed: ${detail}`);
}

async function remoteSubscription(provider, providerSubscriptionId) {
    provider = clean(provider, 20).toLowerCase();
    providerSubscriptionId = clean(providerSubscriptionId, 255);
    if (!['stripe', 'paypal'].includes(provider)) throw new Error('Choose Stripe or PayPal.');
    if (!providerSubscriptionId) throw new Error('Enter the provider subscription ID.');
    return provider === 'stripe' ? stripeRemote(providerSubscriptionId) : paypalRemote(providerSubscriptionId);
}

async function verifyPlan(local, remote) {
    const externalPlanIds = Array.from(new Set((remote.externalPlanIds || []).map(value => clean(value, 255)).filter(Boolean)));
    if (!externalPlanIds.length) throw new Error(`${providerLabel(remote.provider)} did not return a recurring plan/price identity for this subscription.`);
    const mapping = await query(`
        SELECT id,external_id,plan_price_id,active
          FROM plan_provider_prices
         WHERE provider=$1 AND checkout_mode='subscription' AND plan_id=$2
           AND external_id=ANY($3::text[])
         ORDER BY active DESC,updated_at DESC
         LIMIT 1
    `, [remote.provider, local.plan_id, externalPlanIds]);
    if (!mapping.rowCount) {
        if (remote.apiFamily === 'billing-agreements-v1') throw new Error(`PayPal found this legacy billing agreement, but its legacy Billing Plan ID does not map to this customer's local plan.`);
        throw new Error(`${providerLabel(remote.provider)} subscription plan does not map to this customer's local plan.`);
    }
    return { mapping: mapping.rows[0], externalPlanIds };
}

async function verifyOwnership(local, remote) {
    if (!remote.providerCustomerId) {
        const sameEmail = emailKey(remote.email) && emailKey(remote.email) === emailKey(local.email);
        return { verified: Boolean(sameEmail), reason: sameEmail ? 'Provider email matches the portal customer.' : 'Provider returned no customer ID; confirm ownership manually.' };
    }
    const existing = await query(`SELECT customer_id FROM payment_customers WHERE provider=$1 AND provider_customer_id=$2`, [remote.provider, remote.providerCustomerId]);
    if (existing.rowCount) {
        const owners = new Set(existing.rows.map(row => String(row.customer_id)));
        if (!owners.has(String(local.customer_id))) throw new Error('This provider customer identity is already mapped to another CAPTAiNFiN customer.');
        return { verified: true, reason: 'Provider customer ID is already mapped to this portal customer.' };
    }
    const sameEmail = emailKey(remote.email) && emailKey(remote.email) === emailKey(local.email);
    return { verified: Boolean(sameEmail), reason: sameEmail ? 'Provider email matches the portal customer.' : 'Provider identity is not yet mapped; confirm ownership manually.' };
}

async function preview({ subscriptionId, provider, providerSubscriptionId }) {
    const local = await localPremium(subscriptionId);
    const remote = await remoteSubscription(provider, providerSubscriptionId);
    if (!discovery.currentRemote(remote)) throw new Error(`${providerLabel(remote.provider)} subscription is ${remote.status || 'not current'} and cannot be linked to active Premium access.`);
    const duplicate = await query(`SELECT id,customer_id FROM subscriptions WHERE source=$1 AND provider_subscription_id=$2 AND id<>$3 LIMIT 1`, [remote.provider, remote.id, local.subscription_id]);
    if (duplicate.rowCount) throw new Error('This provider subscription is already attached to another local subscription.');
    const { mapping, externalPlanIds } = await verifyPlan(local, remote);
    const identity = await verifyOwnership(local, remote);
    return { local, remote, mapping, externalPlanIds, identity };
}

async function apply({ subscriptionId, provider, providerSubscriptionId, actorUserId, operatorConfirmed = false }) {
    if (!operatorConfirmed) throw new Error('Confirm that you verified this provider subscription belongs to the selected customer.');
    const verified = await preview({ subscriptionId, provider, providerSubscriptionId });
    return lifecycle.attachDiscoveredProviderSubscription({
        subscriptionId: verified.local.subscription_id,
        provider: verified.remote.provider,
        providerCustomerId: verified.remote.providerCustomerId,
        providerSubscriptionId: verified.remote.id,
        providerStatus: verified.remote.status,
        periodEnd: verified.remote.periodEnd,
        cancelAtPeriodEnd: verified.remote.cancelAtPeriodEnd,
        externalPlanIds: verified.externalPlanIds,
        actorUserId,
        matchReason: verified.identity.verified ? `Manual verified link: ${verified.identity.reason}` : 'Manual verified link: operator confirmed ownership after provider preview.'
    });
}

module.exports = { preview, apply, remoteSubscription, localPremium, providerLabel, normalizeLegacyPayPalAgreement };
