'use strict';

const crypto = require('crypto');
const providerSettings = require('./provider-settings');
const lifecycle = require('./lifecycle');
const intents = require('./checkout-intents');
const incidents = require('./incidents');
const referrals = require('../referrals');

function baseUrl(config) {
    return config?.environment === 'live'
        ? 'https://api.coingate.com'
        : 'https://api-sandbox.coingate.com';
}

function enabled() {
    const cfg = providerSettings.peek('coingate');
    return Boolean(cfg?.apiToken && cfg?.callbackSecret);
}

function moneyMinor(value) {
    const amount = Number(value);
    return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null;
}

function callbackTokenFor(secret, intentId) {
    const key = String(secret || '');
    if (key.length < 32) throw new Error('CoinGate callback secret is not configured securely.');
    return crypto.createHmac('sha256', key).update(`coingate:${String(intentId)}`).digest('hex');
}

function safeEqual(left, right) {
    const a = Buffer.from(String(left || ''), 'utf8');
    const b = Buffer.from(String(right || ''), 'utf8');
    return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function parseCallback(rawBody, contentType = '') {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
    if (!text) throw new Error('CoinGate callback body is empty.');
    if (String(contentType).toLowerCase().includes('application/json')) {
        try { return JSON.parse(text); } catch (_) { throw new Error('Invalid CoinGate callback JSON.'); }
    }
    const params = new URLSearchParams(text);
    const payload = {};
    for (const [key, value] of params.entries()) payload[key] = value;
    if (!Object.keys(payload).length) {
        try { return JSON.parse(text); } catch (_) { throw new Error('Invalid CoinGate callback payload.'); }
    }
    return payload;
}

async function api(path, { method = 'GET', body = null, timeoutMs = 15000 } = {}) {
    const cfg = await providerSettings.get('coingate');
    if (!cfg.apiToken) throw new Error('CoinGate API token is not configured.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`${baseUrl(cfg)}${path}`, {
            method,
            signal: controller.signal,
            redirect: 'error',
            headers: {
                Authorization: `Token ${cfg.apiToken}`,
                Accept: 'application/json',
                ...(body ? { 'Content-Type': 'application/json' } : {})
            },
            ...(body ? { body: JSON.stringify(body) } : {})
        });
        const text = await response.text();
        let payload = {};
        if (text) {
            try { payload = JSON.parse(text); } catch (_) { payload = { message: text }; }
        }
        if (!response.ok) {
            const detail = payload?.message || payload?.error || payload?.reason || `HTTP ${response.status}`;
            throw new Error(`CoinGate ${response.status}: ${String(detail).slice(0, 600)}`);
        }
        return payload || {};
    } catch (error) {
        if (error?.name === 'AbortError') throw new Error('CoinGate request timed out.');
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

async function callbackToken(intentId) {
    const cfg = await providerSettings.get('coingate');
    return callbackTokenFor(cfg.callbackSecret, intentId);
}

async function createCheckout({ intentId, resolvedPlan, finalAmountMinor = null, callbackUrl, successUrl, cancelUrl }) {
    if (!intentId) throw new Error('CoinGate checkout intent is required.');
    const plan = resolvedPlan;
    if (!plan) throw new Error('CoinGate checkout plan is required.');
    const baseMinor = Number(plan.price_minor || 0);
    const amountMinor = finalAmountMinor == null ? baseMinor : Number(finalAmountMinor);
    if (!Number.isInteger(amountMinor) || amountMinor < 1 || amountMinor > baseMinor) {
        throw new Error('Adjusted CoinGate checkout amount is invalid.');
    }
    if (!callbackUrl || !successUrl || !cancelUrl) throw new Error('CoinGate checkout URLs are incomplete.');
    const title = String(plan.name || 'CAPTAiNFiN access').trim().slice(0, 150);
    const description = `CAPTAiNFiN access: ${String(plan.name || plan.code || 'streaming plan')}`.slice(0, 500);
    const order = await api('/api/v2/orders', {
        method: 'POST',
        body: {
            order_id: String(intentId),
            price_amount: Number((amountMinor / 100).toFixed(2)),
            price_currency: String(plan.currency || 'GBP').toUpperCase(),
            title: title.length >= 3 ? title : 'CAPTAiNFiN access',
            description: description.length >= 3 ? description : 'CAPTAiNFiN streaming access',
            callback_url: callbackUrl,
            cancel_url: cancelUrl,
            success_url: successUrl,
            token: await callbackToken(intentId)
        }
    });
    if (!order?.id || !order?.payment_url) throw new Error('CoinGate did not return a checkout URL.');
    return { id: String(order.id), url: String(order.payment_url), mode: 'payment' };
}

async function getOrder(providerOrderId) {
    const id = String(providerOrderId || '').trim();
    if (!/^\d+$/.test(id)) throw new Error('Invalid CoinGate order ID.');
    return api(`/api/v2/orders/${encodeURIComponent(id)}`);
}

async function authenticateCallback(payload) {
    const intentId = String(payload?.order_id || '').trim();
    const providerId = String(payload?.id || '').trim();
    if (!intentId || !providerId) throw new Error('CoinGate callback is missing order identifiers.');
    const intent = await intents.findById(intentId);
    if (!intent || intent.provider !== 'coingate') throw new Error('CoinGate callback does not match a local checkout intent.');
    if (!intent.provider_checkout_id || String(intent.provider_checkout_id) !== providerId) {
        throw new Error('CoinGate callback order does not match the local provider order.');
    }
    const cfg = await providerSettings.get('coingate');
    const expected = callbackTokenFor(cfg.callbackSecret, intent.id);
    if (!safeEqual(expected, payload?.token)) throw new Error('Invalid CoinGate callback token.');
    return { intent, providerId };
}

async function verifiedRemoteOrder(providerId, intent) {
    const remote = await getOrder(providerId);
    if (String(remote?.id || '') !== String(providerId)) throw new Error('CoinGate order ID verification failed.');
    if (String(remote?.order_id || '') !== String(intent.id)) throw new Error('CoinGate merchant order ID verification failed.');
    return remote;
}

async function activatePaidOrder(remote, intent) {
    const amountMinor = moneyMinor(remote?.price_amount);
    const currency = String(remote?.price_currency || '').toUpperCase();
    if (amountMinor == null || !currency) throw new Error('CoinGate paid order is missing price verification data.');
    const contract = await intents.verifiedProviderContract({
        provider: 'coingate',
        providerCheckoutId: String(remote.id),
        scope: 'customer',
        ownerId: intent.customer_id,
        planId: intent.plan_id,
        checkoutMode: 'payment',
        amountMinor,
        currency
    });
    await lifecycle.activatePurchase({
        customerId: intent.customer_id,
        planId: intent.plan_id,
        provider: 'coingate',
        providerSubscriptionId: String(remote.id),
        providerStatus: 'paid',
        commercialSnapshot: contract.snapshot
    });
    await intents.completeVerifiedProvider('coingate', String(remote.id), 'completed');
    return { status: 'paid', completed: true };
}

async function recordRefund(remote, intent, eventId) {
    const providerId = String(remote.id);
    const fullRefund = String(remote.status || '').toLowerCase() === 'refunded';
    const amountMinor = fullRefund ? moneyMinor(remote.price_amount) : null;
    const identity = await incidents.identityFromProviderSubscription('coingate', providerId);
    const recorded = await incidents.record({
        provider: 'coingate',
        eventId,
        caseId: providerId,
        kind: 'refund',
        status: 'recorded',
        identity,
        providerSubscriptionId: providerId,
        amountMinor,
        currency: remote.price_currency || null,
        metadata: {
            fullRefund,
            coinGateStatus: remote.status || null,
            paidAt: remote.paid_at || null
        }
    });
    if (fullRefund && identity.scope === 'direct' && identity.customerId) {
        await referrals.revisitRewardAfterAdversePayment({
            referredCustomerId: identity.customerId,
            incidentId: recorded?.incident?.id || null,
            reason: `coingate:refund:${eventId}`,
            amountMinor,
            fullLoss: true
        });
    }
    return recorded;
}

async function applyRemoteOrder(remote, intent, { eventId = null, recordRisk = true } = {}) {
    const status = String(remote?.status || '').toLowerCase();
    if (status === 'paid') return activatePaidOrder(remote, intent);
    if (['pending', 'confirming', 'new'].includes(status)) return { status, completed: false, waiting: true };
    if (['expired', 'canceled'].includes(status)) {
        await intents.completeVerifiedProvider('coingate', String(remote.id), 'cancelled');
        return { status, completed: false, terminal: true };
    }
    if (status === 'invalid') {
        await intents.completeVerifiedProvider('coingate', String(remote.id), 'failed');
        return { status, completed: false, terminal: true };
    }
    if (['refunded', 'partially_refunded'].includes(status)) {
        await intents.completeVerifiedProvider('coingate', String(remote.id), 'failed');
        if (recordRisk && eventId) await recordRefund(remote, intent, eventId);
        return { status, completed: false, terminal: true, refunded: true };
    }
    return { status: status || 'unknown', completed: false };
}

async function processWebhook(rawBody, contentType = '') {
    const payload = parseCallback(rawBody, contentType);
    const { intent, providerId } = await authenticateCallback(payload);
    const remote = await verifiedRemoteOrder(providerId, intent);
    const status = String(remote?.status || payload?.status || 'unknown').toLowerCase();
    const marker = String(remote?.paid_at || remote?.updated_at || remote?.created_at || '').slice(0, 80);
    const eventId = `order:${providerId}:${status}:${marker}`;
    const eventRow = await lifecycle.beginPaymentEvent({
        provider: 'coingate',
        eventId,
        eventType: `order.${status}`,
        payload
    });
    if (!eventRow) return { duplicate: true, status };
    try {
        const result = await applyRemoteOrder(remote, intent, { eventId, recordRisk: true });
        await lifecycle.finishPaymentEvent(eventRow);
        return { duplicate: false, ...result };
    } catch (error) {
        await lifecycle.finishPaymentEvent(eventRow, error);
        throw error;
    }
}

async function confirmCheckout(providerOrderId, intent) {
    const remote = await verifiedRemoteOrder(providerOrderId, intent);
    return applyRemoteOrder(remote, intent, { recordRisk: false });
}

module.exports = {
    enabled,
    baseUrl,
    api,
    createCheckout,
    getOrder,
    parseCallback,
    callbackTokenFor,
    moneyMinor,
    processWebhook,
    confirmCheckout,
    applyRemoteOrder,
    authenticateCallback,
    verifiedRemoteOrder
};
