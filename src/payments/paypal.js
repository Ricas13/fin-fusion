'use strict';

const crypto = require('crypto');
const lifecycle = require('./lifecycle');
const discounts = require('./discounts');
const providerSettings = require('./provider-settings');

let cachedToken = null;
let cachedUntil = 0;
let cachedCredentialKey = null;

function enabled() {
    const cfg = providerSettings.peek('paypal');
    return Boolean(cfg?.clientId && cfg?.clientSecret);
}

function baseUrl(config) {
    return config?.environment === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';
}

async function accessToken() {
    const config = await providerSettings.get('paypal');
    if (!config.clientId || !config.clientSecret) throw new Error('PayPal is not configured');
    const credentialKey = `${config.environment || 'sandbox'}:${config.clientId}:${config.clientSecret}`;
    if (cachedCredentialKey !== credentialKey) {
        cachedToken = null;
        cachedUntil = 0;
        cachedCredentialKey = credentialKey;
    }
    if (cachedToken && Date.now() < cachedUntil - 60000) return { token: cachedToken, config };
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const response = await fetch(`${baseUrl(config)}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
            Authorization: `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json'
        },
        body: 'grant_type=client_credentials'
    });
    const payload = await response.json();
    if (!response.ok || !payload.access_token) throw new Error(`PayPal OAuth failed: ${payload.error_description || response.status}`);
    cachedToken = payload.access_token;
    cachedUntil = Date.now() + Number(payload.expires_in || 300) * 1000;
    return { token: cachedToken, config };
}

async function api(path, { method = 'GET', body = null, requestId = null } = {}) {
    const { token, config } = await accessToken();
    const response = await fetch(`${baseUrl(config)}${path}`, {
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
    let payload = null;
    if (text) {
        try { payload = JSON.parse(text); } catch { payload = text; }
    }
    if (!response.ok) {
        const detail = typeof payload === 'object' ? payload?.message || payload?.name : payload;
        throw new Error(`PayPal HTTP ${response.status}: ${detail || 'request failed'}`);
    }
    return payload || {};
}

function customId(customerId, planId, discountCodeId = null) {
    return discountCodeId ? `${customerId}:${planId}:${discountCodeId}` : `${customerId}:${planId}`;
}

function parseCustomId(value) {
    const match = String(value || '').match(/^([0-9a-f-]{36}):([0-9a-f-]{36})(?::([0-9a-f-]{36}))?$/i);
    return match ? { customerId: match[1], planId: match[2], discountCodeId: match[3] || null } : null;
}

function approvalUrl(payload) {
    const links = Array.isArray(payload?.links) ? payload.links : [];
    return links.find(l => ['approve', 'payer-action'].includes(l.rel))?.href || null;
}

async function createCheckout({ customerId, planCode, returnUrl, cancelUrl, discountCode = null, checkoutMode = null }) {
    const plan = await lifecycle.getProviderPlan(planCode, 'paypal', checkoutMode);
    if (!plan) throw new Error('This plan is not configured for the selected PayPal payment type');
    const idempotencyKey = crypto.randomUUID();

    if (plan.checkout_mode === 'subscription') {
        if (!plan.external_id) throw new Error('This PayPal recurring option has no Billing Plan ID');
        if (discountCode) throw new Error('Discount codes are not supported for PayPal subscriptions yet. Use Stripe or a one-time PayPal payment.');
        const subscription = await api('/v1/billing/subscriptions', {
            method: 'POST',
            requestId: idempotencyKey,
            body: {
                plan_id: plan.external_id,
                custom_id: customId(customerId, plan.id),
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
        if (!url) throw new Error('PayPal did not return a subscription approval URL');
        return { id: subscription.id, url, mode: 'subscription' };
    }

    let amountMinor = Number(plan.price_minor);
    let discount = null;
    if (discountCode) {
        discount = await discounts.validateForCheckout({ code: discountCode, planId: plan.id, planCode, customerId });
        if (discount.discount_type === 'fixed' && discount.currency && String(discount.currency).toUpperCase() !== String(plan.currency).toUpperCase()) {
            throw new Error("That discount code's currency does not match this plan");
        }
        amountMinor = discounts.computeDiscountedMinor(amountMinor, discount);
    }
    const value = (amountMinor / 100).toFixed(2);
    const order = await api('/v2/checkout/orders', {
        method: 'POST',
        requestId: idempotencyKey,
        body: {
            intent: 'CAPTURE',
            purchase_units: [{
                custom_id: customId(customerId, plan.id, discount?.id),
                description: plan.name,
                amount: { currency_code: String(plan.currency).toUpperCase(), value }
            }],
            payment_source: {
                paypal: {
                    experience_context: {
                        brand_name: process.env.SITE_NAME || 'CAPTaINFiN',
                        shipping_preference: 'NO_SHIPPING',
                        user_action: 'PAY_NOW',
                        return_url: returnUrl,
                        cancel_url: cancelUrl
                    }
                }
            }
        }
    });
    const url = approvalUrl(order);
    if (!url) throw new Error('PayPal did not return an order approval URL');
    return { id: order.id, url, mode: 'payment' };
}

async function captureOrder(orderId) {
    const order = await api(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
        method: 'POST',
        requestId: `capture-${orderId}`
    });
    if (order.status !== 'COMPLETED') throw new Error(`PayPal order is ${order.status || 'not completed'}`);
    const unit = order.purchase_units?.[0];
    const mapping = parseCustomId(unit?.custom_id);
    if (!mapping) throw new Error('PayPal order is missing internal purchase metadata');
    const capture = unit?.payments?.captures?.[0];
    const providerId = capture?.id || order.id;
    const payerId = order.payer?.payer_id || null;

    return lifecycle.activatePurchase({
        customerId: mapping.customerId,
        planId: mapping.planId,
        provider: 'paypal',
        providerCustomerId: payerId,
        providerSubscriptionId: providerId,
        providerStatus: 'active',
        discountCodeId: mapping.discountCodeId
    });
}

async function getSubscription(subscriptionId) {
    return api(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

async function activateSubscription(subscriptionId) {
    const subscription = await getSubscription(subscriptionId);
    const mapping = parseCustomId(subscription.custom_id);
    if (!mapping) throw new Error('PayPal subscription is missing internal purchase metadata');
    const nextBilling = subscription.billing_info?.next_billing_time || null;
    return lifecycle.activatePurchase({
        customerId: mapping.customerId,
        planId: mapping.planId,
        provider: 'paypal',
        providerSubscriptionId: subscription.id,
        providerStatus: subscription.status,
        periodStart: subscription.start_time || new Date(),
        periodEnd: nextBilling,
        cancelAtPeriodEnd: false
    });
}

async function verifyWebhook(headers, event) {
    const config = await providerSettings.get('paypal');
    const webhookId = config.webhookId;
    if (!webhookId) throw new Error('PayPal webhook ID is not configured');
    const result = await api('/v1/notifications/verify-webhook-signature', {
        method: 'POST',
        body: {
            auth_algo: headers['paypal-auth-algo'],
            cert_url: headers['paypal-cert-url'],
            transmission_id: headers['paypal-transmission-id'],
            transmission_sig: headers['paypal-transmission-sig'],
            transmission_time: headers['paypal-transmission-time'],
            webhook_id: webhookId,
            webhook_event: event
        }
    });
    return result.verification_status === 'SUCCESS';
}

async function processWebhook(rawBody, headers) {
    let event;
    try { event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)); }
    catch { throw new Error('Invalid PayPal webhook JSON'); }
    if (!(await verifyWebhook(headers, event))) throw new Error('Invalid PayPal webhook signature');

    const eventId = event.id;
    const eventType = event.event_type;
    const eventRow = await lifecycle.beginPaymentEvent({ provider: 'paypal', eventId, eventType, payload: event });
    if (!eventRow) return { duplicate: true };

    try {
        const resource = event.resource || {};
        switch (eventType) {
            case 'BILLING.SUBSCRIPTION.ACTIVATED':
            case 'BILLING.SUBSCRIPTION.UPDATED':
                await activateSubscription(resource.id);
                break;
            case 'BILLING.SUBSCRIPTION.CANCELLED':
            case 'BILLING.SUBSCRIPTION.SUSPENDED':
            case 'BILLING.SUBSCRIPTION.EXPIRED':
                await lifecycle.updateProviderSubscription({
                    provider: 'paypal',
                    providerSubscriptionId: resource.id,
                    providerStatus: resource.status || eventType.split('.').pop()
                });
                break;
            case 'PAYMENT.SALE.COMPLETED': {
                const subscriptionId = resource.billing_agreement_id;
                if (subscriptionId) await activateSubscription(subscriptionId);
                break;
            }
            default:
                break;
        }
        await lifecycle.finishPaymentEvent(eventRow);
        return { duplicate: false, type: eventType };
    } catch (error) {
        await lifecycle.finishPaymentEvent(eventRow, error);
        throw error;
    }
}

module.exports = {
    enabled,
    createCheckout,
    captureOrder,
    activateSubscription,
    processWebhook
};
