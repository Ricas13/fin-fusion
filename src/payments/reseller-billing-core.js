'use strict';

const crypto = require('crypto');
const Stripe = require('stripe');
const { query } = require('../db');
const providerSettings = require('./provider-settings');
const lifecycle = require('./lifecycle');
const monthly = require('../resellers/monthly');

let stripeClient = null;
let stripeKey = null;
let paypalToken = null;
let paypalTokenUntil = 0;
let paypalCredentialKey = null;

function stripeApiKey(config) {
    return config?.restrictedKey || config?.apiKey || '';
}

async function stripe() {
    const config = await providerSettings.get('stripe');
    const key = stripeApiKey(config);
    if (!key) throw new Error('Stripe is not configured.');
    if (!stripeClient || stripeKey !== key) {
        stripeClient = new Stripe(key, { apiVersion: '2026-06-24.dahlia', appInfo: { name: 'CAPTaINFiN Reseller Billing', version: '1.0.0' } });
        stripeKey = key;
    }
    return stripeClient;
}

function paypalBase(config) {
    return config?.environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

async function paypalAccess() {
    const config = await providerSettings.get('paypal');
    if (!config.clientId || !config.clientSecret) throw new Error('PayPal is not configured.');
    const key = `${config.environment || 'sandbox'}:${config.clientId}:${config.clientSecret}`;
    if (key !== paypalCredentialKey) {
        paypalCredentialKey = key;
        paypalToken = null;
        paypalTokenUntil = 0;
    }
    if (paypalToken && Date.now() < paypalTokenUntil - 60000) return { token: paypalToken, config };
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const response = await fetch(`${paypalBase(config)}/v1/oauth2/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: 'grant_type=client_credentials'
    });
    const payload = await response.json();
    if (!response.ok || !payload.access_token) throw new Error(`PayPal OAuth failed: ${payload.error_description || response.status}`);
    paypalToken = payload.access_token;
    paypalTokenUntil = Date.now() + Number(payload.expires_in || 300) * 1000;
    return { token: paypalToken, config };
}

async function paypalApi(path, { method = 'GET', body = null, requestId = null } = {}) {
    const { token, config } = await paypalAccess();
    const response = await fetch(`${paypalBase(config)}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(requestId ? { 'PayPal-Request-Id': requestId } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
    });
    const text = await response.text();
    let payload = {};
    if (text) {
        try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    }
    if (!response.ok) throw new Error(`PayPal HTTP ${response.status}: ${payload.message || payload.name || 'request failed'}`);
    return payload;
}

function stripePeriod(subscription) {
    const items = subscription?.items?.data || [];
    const starts = items.map(i => Number(i.current_period_start)).filter(Number.isFinite);
    const ends = items.map(i => Number(i.current_period_end)).filter(Number.isFinite);
    return {
        start: starts.length ? new Date(Math.min(...starts) * 1000) : new Date(Number(subscription?.created || Date.now() / 1000) * 1000),
        end: ends.length ? new Date(Math.max(...ends) * 1000) : null
    };
}

function paypalCustomId(resellerId, tierId) {
    return `reseller:${resellerId}:${tierId}`;
}

function parsePaypalCustomId(value) {
    const match = String(value || '').match(/^reseller:([0-9a-f-]{36}):([0-9a-f-]{36})$/i);
    return match ? { resellerId: match[1], tierId: match[2] } : null;
}

function approvalUrl(payload) {
    return (Array.isArray(payload?.links) ? payload.links : []).find(x => ['approve','payer-action'].includes(x.rel))?.href || null;
}

async function resellerIdentity(resellerId) {
    const result = await query(`SELECT r.id,u.email,u.username FROM resellers r JOIN app_users u ON u.id=r.user_id WHERE r.id=$1`, [resellerId]);
    if (!result.rowCount) throw new Error('Reseller not found.');
    return result.rows[0];
}

async function ensureStripeCustomer(resellerId) {
    const found = await query("SELECT provider_customer_id FROM reseller_payment_customers WHERE reseller_id=$1 AND provider='stripe'", [resellerId]);
    if (found.rowCount) return found.rows[0].provider_customer_id;
    const identity = await resellerIdentity(resellerId);
    const client = await stripe();
    const customer = await client.customers.create({
        email: identity.email || undefined,
        name: identity.username || undefined,
        metadata: { billing_scope: 'reseller', internal_reseller_id: resellerId }
    });
    await query(`INSERT INTO reseller_payment_customers(reseller_id,provider,provider_customer_id) VALUES($1,'stripe',$2) ON CONFLICT(reseller_id,provider) DO UPDATE SET provider_customer_id=EXCLUDED.provider_customer_id,updated_at=NOW()`, [resellerId, customer.id]);
    return customer.id;
}

async function createStripeCheckout({ resellerId, tierId, successUrl, cancelUrl, idempotencyKey = null }) {
    const mapping = await monthly.providerMapping(tierId, 'stripe');
    if (!mapping) throw new Error('This reseller tier is not configured for Stripe recurring billing.');
    const customerId = await ensureStripeCustomer(resellerId);
    const client = await stripe();
    const metadata = {
        billing_scope: 'reseller',
        internal_reseller_id: resellerId,
        internal_reseller_tier_id: tierId,
        ...(idempotencyKey ? { internal_checkout_intent_id: String(idempotencyKey) } : {})
    };
    const params = {
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: mapping.external_id, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata,
        subscription_data: { metadata }
    };
    const session = idempotencyKey
        ? await client.checkout.sessions.create(params, { idempotencyKey: `reseller-checkout-${String(idempotencyKey)}` })
        : await client.checkout.sessions.create(params);
    return { id: session.id, url: session.url };
}

async function createPayPalCheckout({ resellerId, tierId, returnUrl, cancelUrl, idempotencyKey = null }) {
    const mapping = await monthly.providerMapping(tierId, 'paypal');
    if (!mapping) throw new Error('This reseller tier is not configured for PayPal recurring billing.');
    const subscription = await paypalApi('/v1/billing/subscriptions', {
        method: 'POST',
        requestId: idempotencyKey ? String(idempotencyKey) : crypto.randomUUID(),
        body: {
            plan_id: mapping.external_id,
            custom_id: paypalCustomId(resellerId, tierId),
            application_context: {
                brand_name: process.env.SITE_NAME || 'CAPTaINFiN',
                shipping_preference: 'NO_SHIPPING',
                user_action: 'SUBSCRIBE_NOW',
                return_url: returnUrl,
                cancel_url: cancelUrl
            }
        }
    });
    const url = approvalUrl(subscription);
    if (!url) throw new Error('PayPal did not return an approval URL.');
    return { id: subscription.id, url };
}

async function syncStripeSubscription(subscriptionId, statusOverride = null) {
    const client = await stripe();
    const subscription = await client.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price'] });
    const meta = subscription.metadata || {};
    let resellerId = meta.internal_reseller_id;
    let tierId = meta.internal_reseller_tier_id;
    if (!resellerId || !tierId) {
        const known = await query("SELECT reseller_id,tier_id FROM reseller_subscriptions WHERE source='stripe' AND provider_subscription_id=$1 ORDER BY created_at DESC LIMIT 1", [subscriptionId]);
        if (!known.rowCount) return null;
        resellerId = known.rows[0].reseller_id;
        tierId = known.rows[0].tier_id;
    }
    const period = stripePeriod(subscription);
    if (!period.end) throw new Error('Stripe subscription has no billing period end.');
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id || null;
    return monthly.setProviderSubscription({
        resellerId, tierId, provider: 'stripe', providerCustomerId: customerId,
        providerSubscriptionId: subscription.id, providerStatus: statusOverride || subscription.status,
        periodStart: period.start, periodEnd: period.end,
        cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end)
    });
}

async function activatePayPalSubscription(subscriptionId) {
    const subscription = await paypalApi(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`);
    const mapping = parsePaypalCustomId(subscription.custom_id);
    let resellerId = mapping?.resellerId;
    let tierId = mapping?.tierId;
    if (!resellerId || !tierId) {
        const known = await query("SELECT reseller_id,tier_id FROM reseller_subscriptions WHERE source='paypal' AND provider_subscription_id=$1 ORDER BY created_at DESC LIMIT 1", [subscriptionId]);
        if (!known.rowCount) return null;
        resellerId = known.rows[0].reseller_id;
        tierId = known.rows[0].tier_id;
    }
    const nextBilling = subscription.billing_info?.next_billing_time || null;
    let end = nextBilling ? new Date(nextBilling) : null;
    if (!end || !Number.isFinite(end.getTime())) {
        const existing = await query("SELECT current_period_end FROM reseller_subscriptions WHERE source='paypal' AND provider_subscription_id=$1 ORDER BY created_at DESC LIMIT 1", [subscriptionId]);
        end = existing.rowCount ? new Date(existing.rows[0].current_period_end) : new Date(Date.now() + 31 * 86400000);
    }
    return monthly.setProviderSubscription({
        resellerId, tierId, provider: 'paypal', providerSubscriptionId: subscription.id,
        providerStatus: subscription.status, periodStart: subscription.start_time || new Date(), periodEnd: end,
        cancelAtPeriodEnd: ['CANCELLED','EXPIRED'].includes(String(subscription.status || '').toUpperCase())
    });
}

function parseRaw(rawBody) {
    try { return JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)); }
    catch { return null; }
}

function stripeObjectSubscriptionId(object) {
    const direct = typeof object?.subscription === 'string' ? object.subscription : object?.subscription?.id;
    if (direct) return direct;
    const parent = object?.parent?.subscription_details?.subscription;
    return typeof parent === 'string' ? parent : parent?.id || null;
}

async function isStripeResellerEvent(rawBody) {
    const event = parseRaw(rawBody);
    const object = event?.data?.object || {};
    if (object?.metadata?.billing_scope === 'reseller') return true;
    const subscriptionId = event?.type?.startsWith('customer.subscription.') ? object.id : stripeObjectSubscriptionId(object);
    if (!subscriptionId) return false;
    const known = await query("SELECT 1 FROM reseller_subscriptions WHERE source='stripe' AND provider_subscription_id=$1 LIMIT 1", [subscriptionId]);
    return known.rowCount > 0;
}

async function processStripeWebhook(rawBody, signature) {
    const config = await providerSettings.get('stripe');
    if (!config.webhookSecret) throw new Error('Stripe webhook secret is not configured.');
    const client = await stripe();
    const event = client.webhooks.constructEvent(rawBody, signature, config.webhookSecret);
    const eventRow = await lifecycle.beginPaymentEvent({ provider: 'stripe', eventId: event.id, eventType: event.type, payload: event });
    if (!eventRow) return { duplicate: true };
    try {
        const object = event.data?.object || {};
        switch (event.type) {
            case 'checkout.session.completed': {
                if (object.metadata?.billing_scope !== 'reseller') break;
                const subscriptionId = typeof object.subscription === 'string' ? object.subscription : object.subscription?.id;
                if (subscriptionId) await syncStripeSubscription(subscriptionId);
                break;
            }
            case 'customer.subscription.created':
            case 'customer.subscription.updated':
            case 'customer.subscription.deleted':
                await syncStripeSubscription(object.id);
                break;
            case 'invoice.paid': {
                const id = stripeObjectSubscriptionId(object);
                if (id) await syncStripeSubscription(id, 'active');
                break;
            }
            case 'invoice.payment_failed': {
                const id = stripeObjectSubscriptionId(object);
                if (id) await syncStripeSubscription(id, 'past_due');
                break;
            }
            default:
                break;
        }
        await lifecycle.finishPaymentEvent(eventRow);
        return { duplicate: false, type: event.type };
    } catch (error) {
        await lifecycle.finishPaymentEvent(eventRow, error);
        throw error;
    }
}

async function verifyPayPalWebhook(headers, event) {
    const config = await providerSettings.get('paypal');
    if (!config.webhookId) throw new Error('PayPal webhook ID is not configured.');
    const result = await paypalApi('/v1/notifications/verify-webhook-signature', {
        method: 'POST',
        body: {
            auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'],
            transmission_id: headers['paypal-transmission-id'], transmission_sig: headers['paypal-transmission-sig'],
            transmission_time: headers['paypal-transmission-time'], webhook_id: config.webhookId, webhook_event: event
        }
    });
    return result.verification_status === 'SUCCESS';
}

async function isPayPalResellerEvent(rawBody) {
    const event = parseRaw(rawBody);
    const resource = event?.resource || {};
    if (parsePaypalCustomId(resource.custom_id)) return true;
    const subscriptionId = resource.billing_agreement_id || (String(event?.event_type || '').startsWith('BILLING.SUBSCRIPTION.') ? resource.id : null);
    if (!subscriptionId) return false;
    const known = await query("SELECT 1 FROM reseller_subscriptions WHERE source='paypal' AND provider_subscription_id=$1 LIMIT 1", [subscriptionId]);
    return known.rowCount > 0;
}

async function processPayPalWebhook(rawBody, headers) {
    const event = parseRaw(rawBody);
    if (!event) throw new Error('Invalid PayPal webhook JSON.');
    if (!(await verifyPayPalWebhook(headers, event))) throw new Error('Invalid PayPal webhook signature.');
    const eventRow = await lifecycle.beginPaymentEvent({ provider: 'paypal', eventId: event.id, eventType: event.event_type, payload: event });
    if (!eventRow) return { duplicate: true };
    try {
        const resource = event.resource || {};
        switch (event.event_type) {
            case 'BILLING.SUBSCRIPTION.ACTIVATED':
            case 'BILLING.SUBSCRIPTION.UPDATED':
            case 'BILLING.SUBSCRIPTION.CANCELLED':
            case 'BILLING.SUBSCRIPTION.SUSPENDED':
            case 'BILLING.SUBSCRIPTION.EXPIRED':
                if (resource.id) await activatePayPalSubscription(resource.id);
                break;
            case 'PAYMENT.SALE.COMPLETED':
                if (resource.billing_agreement_id) await activatePayPalSubscription(resource.billing_agreement_id);
                break;
            case 'PAYMENT.SALE.DENIED':
            case 'PAYMENT.SALE.REFUNDED':
                if (resource.billing_agreement_id) {
                    await monthly.updateKnownProviderSubscription({ provider: 'paypal', providerSubscriptionId: resource.billing_agreement_id, providerStatus: 'past_due' });
                }
                break;
            default:
                break;
        }
        await lifecycle.finishPaymentEvent(eventRow);
        return { duplicate: false, type: event.event_type };
    } catch (error) {
        await lifecycle.finishPaymentEvent(eventRow, error);
        throw error;
    }
}

async function syncDue({ limit = 50 } = {}) {
    const due = await query(`
        SELECT source,provider_subscription_id
        FROM reseller_subscriptions
        WHERE source IN ('stripe','paypal') AND provider_subscription_id IS NOT NULL
          AND status IN ('active','past_due','cancelled')
          AND (last_provider_sync_at IS NULL OR last_provider_sync_at < NOW()-INTERVAL '15 minutes')
        ORDER BY COALESCE(last_provider_sync_at,'1970-01-01'::timestamptz) ASC
        LIMIT $1
    `, [limit]);
    const summary = { total: due.rowCount, succeeded: 0, failed: 0 };
    for (const row of due.rows) {
        try {
            if (row.source === 'stripe') await syncStripeSubscription(row.provider_subscription_id);
            else await activatePayPalSubscription(row.provider_subscription_id);
            summary.succeeded += 1;
        } catch (error) {
            summary.failed += 1;
            await query(`UPDATE reseller_subscriptions SET last_provider_sync_at=NOW(),last_provider_error=$3,updated_at=NOW() WHERE source=$1 AND provider_subscription_id=$2`, [row.source, row.provider_subscription_id, String(error.message || error).slice(0, 1000)]);
        }
    }
    return summary;
}

async function cancelRenewal(resellerId) {
    const current = await monthly.currentSubscription(resellerId);
    if (!current || !current.provider_subscription_id || !['stripe','paypal'].includes(current.source)) throw new Error('No recurring provider subscription is active.');
    if (current.source === 'stripe') {
        const client = await stripe();
        await client.subscriptions.update(current.provider_subscription_id, { cancel_at_period_end: true });
        return syncStripeSubscription(current.provider_subscription_id);
    }
    await paypalApi(`/v1/billing/subscriptions/${encodeURIComponent(current.provider_subscription_id)}/cancel`, {
        method: 'POST', requestId: crypto.randomUUID(), body: { reason: 'Customer requested cancellation' }
    });
    await query(`UPDATE reseller_subscriptions SET cancel_at_period_end=TRUE,updated_at=NOW() WHERE id=$1`, [current.id]);
    return current;
}

module.exports = {
    createStripeCheckout,
    createPayPalCheckout,
    activatePayPalSubscription,
    syncStripeSubscription,
    isStripeResellerEvent,
    processStripeWebhook,
    isPayPalResellerEvent,
    processPayPalWebhook,
    syncDue,
    cancelRenewal,
    parsePaypalCustomId,
    stripePeriod
};