'use strict';

const crypto = require('crypto');
const providerSettings = require('./provider-settings');
const lifecycle = require('./lifecycle');
const intents = require('./checkout-intents');

const API_BASE = 'https://api.plisio.net';

function enabled() {
    const cfg = providerSettings.peek('plisio');
    return Boolean(cfg?.secretKey);
}

function safeEqual(left, right) {
    const a = Buffer.from(String(left || ''), 'utf8');
    const b = Buffer.from(String(right || ''), 'utf8');
    return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function moneyMinor(value) {
    const amount = Number(value);
    return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null;
}

function parseCallback(rawBody, contentType = '') {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
    if (!text) throw new Error('Plisio callback body is empty.');
    if (!String(contentType).toLowerCase().includes('application/json')) {
        throw new Error('Plisio callback must use JSON mode.');
    }
    try {
        const payload = JSON.parse(text);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('not an object');
        return payload;
    } catch (_) {
        throw new Error('Invalid Plisio callback JSON.');
    }
}

function callbackDigest(secretKey, payload) {
    const key = String(secretKey || '');
    if (!key) throw new Error('Plisio secret key is not configured.');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid Plisio callback payload.');
    const ordered = { ...payload };
    delete ordered.verify_hash;
    return crypto.createHmac('sha1', key).update(JSON.stringify(ordered)).digest('hex');
}

async function api(path, params = {}, { timeoutMs = 15000 } = {}) {
    const cfg = await providerSettings.get('plisio');
    if (!cfg.secretKey) throw new Error('Plisio secret key is not configured.');
    if (typeof path !== 'string' || !path.startsWith('/api/v1/') || path.startsWith('//')) throw new Error('Invalid Plisio API path.');
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(params || {})) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    url.searchParams.set('api_key', cfg.secretKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { method: 'GET', signal: controller.signal, redirect: 'error', headers: { Accept: 'application/json' } });
        const text = await response.text();
        let payload = {};
        if (text) {
            try { payload = JSON.parse(text); } catch (_) { payload = { data: { message: text } }; }
        }
        if (!response.ok || payload?.status === 'error') {
            const detail = payload?.data?.message || payload?.message || payload?.error || `HTTP ${response.status}`;
            console.error(`Plisio API error (${response.status}):`, String(detail).slice(0, 600));
            throw new Error('This payment method is temporarily unavailable. Please try Stripe or PayPal, or contact support if you keep seeing this.');
        }
        return payload?.status === 'success' && payload?.data !== undefined ? payload.data : payload;
    } catch (error) {
        if (error?.name === 'AbortError') throw new Error('Plisio request timed out.');
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

async function createCheckout({ intentId, resolvedPlan, finalAmountMinor = null, callbackUrl, successUrl, cancelUrl }) {
    if (!intentId) throw new Error('Plisio checkout intent is required.');
    const plan = resolvedPlan;
    if (!plan) throw new Error('Plisio checkout plan is required.');
    const baseMinor = Number(plan.price_minor || 0);
    const amountMinor = finalAmountMinor == null ? baseMinor : Number(finalAmountMinor);
    if (!Number.isInteger(amountMinor) || amountMinor < 1 || amountMinor > baseMinor) throw new Error('Adjusted Plisio checkout amount is invalid.');
    if (!callbackUrl || !successUrl || !cancelUrl) throw new Error('Plisio checkout URLs are incomplete.');
    const callback = new URL(callbackUrl);
    callback.searchParams.set('json', 'true');
    const invoice = await api('/api/v1/invoices/new', {
        order_name: String(plan.name || 'CAPTAiNFiN access').trim().slice(0, 150) || 'CAPTAiNFiN access',
        order_number: String(intentId),
        source_currency: String(plan.currency || 'GBP').toUpperCase(),
        source_amount: (amountMinor / 100).toFixed(2),
        callback_url: callback.toString(),
        success_callback_url: successUrl,
        fail_callback_url: cancelUrl,
        success_invoice_url: successUrl,
        fail_invoice_url: cancelUrl,
        expire_min: 180
    });
    if (!invoice?.txn_id || !invoice?.invoice_url) throw new Error('Plisio did not return a checkout URL.');
    return { id: String(invoice.txn_id), url: String(invoice.invoice_url), mode: 'payment' };
}

function operationFields(remote) {
    const params = remote?.params && typeof remote.params === 'object' ? remote.params : {};
    return {
        id: String(remote?.txn_id || remote?.id || '').trim(),
        orderNumber: String(remote?.order_number || params.order_number || '').trim(),
        status: String(remote?.status || '').toLowerCase(),
        sourceAmount: remote?.source_amount ?? params.source_amount ?? null,
        sourceCurrency: String(remote?.source_currency || params.source_currency || '').toUpperCase()
    };
}

async function getOperation(providerTxnId) {
    const id = String(providerTxnId || '').trim();
    if (!/^[A-Za-z0-9._:-]{3,200}$/.test(id)) throw new Error('Invalid Plisio transaction ID.');
    return api(`/api/v1/operations/${encodeURIComponent(id)}`);
}

async function authenticateCallback(payload) {
    const providerId = String(payload?.txn_id || '').trim();
    const intentId = String(payload?.order_number || '').trim();
    if (!providerId || !intentId || !payload?.verify_hash) throw new Error('Plisio callback is missing verification fields.');
    const intent = await intents.findById(intentId);
    if (!intent || intent.provider !== 'plisio') throw new Error('Plisio callback does not match a local checkout intent.');
    if (!intent.provider_checkout_id || String(intent.provider_checkout_id) !== providerId) throw new Error('Plisio callback transaction does not match the local checkout.');
    const cfg = await providerSettings.get('plisio');
    const expected = callbackDigest(cfg.secretKey, payload);
    if (!safeEqual(expected, payload.verify_hash)) throw new Error('Invalid Plisio callback signature.');
    return { intent, providerId };
}

async function verifiedRemoteOperation(providerId, intent) {
    const remote = await getOperation(providerId);
    const fields = operationFields(remote);
    if (fields.id !== String(providerId)) throw new Error('Plisio transaction ID verification failed.');
    if (fields.orderNumber !== String(intent.id)) throw new Error('Plisio merchant order number verification failed.');
    return { remote, fields };
}

async function activateCompleted(remote, fields, intent) {
    const amountMinor = moneyMinor(fields.sourceAmount);
    if (amountMinor == null || !fields.sourceCurrency) throw new Error('Plisio completed transaction is missing fiat verification data.');
    const contract = await intents.verifiedProviderContract({
        provider: 'plisio', providerCheckoutId: fields.id, scope: 'customer', ownerId: intent.customer_id,
        planId: intent.plan_id, checkoutMode: 'payment', amountMinor, currency: fields.sourceCurrency
    });
    await lifecycle.activatePurchase({
        customerId: intent.customer_id,
        planId: intent.plan_id,
        provider: 'plisio',
        providerSubscriptionId: fields.id,
        providerStatus: 'completed',
        commercialSnapshot: contract.snapshot
    });
    await intents.completeVerifiedProvider('plisio', fields.id, 'completed');
    return { status: 'completed', completed: true };
}

async function applyRemoteOperation(remote, intent) {
    const fields = operationFields(remote);
    if (fields.status === 'completed') return activateCompleted(remote, fields, intent);
    if (['new', 'pending', 'pending internal'].includes(fields.status)) return { status: fields.status, completed: false, waiting: true };
    if (['expired', 'cancelled', 'cancelled duplicate'].includes(fields.status)) {
        await intents.completeVerifiedProvider('plisio', fields.id, 'cancelled');
        return { status: fields.status, completed: false, terminal: true };
    }
    if (['error', 'mismatch'].includes(fields.status)) {
        await intents.completeVerifiedProvider('plisio', fields.id, 'failed');
        return { status: fields.status, completed: false, terminal: true };
    }
    return { status: fields.status || 'unknown', completed: false };
}

async function processClaimedCallback(eventRow, payload) {
    try {
        const { intent, providerId } = await authenticateCallback(payload);
        const { remote } = await verifiedRemoteOperation(providerId, intent);
        const result = await applyRemoteOperation(remote, intent);
        await lifecycle.finishPaymentEvent(eventRow);
        return { processed: true, ...result };
    } catch (error) {
        await lifecycle.finishPaymentEvent(eventRow, error);
        console.error('Plisio webhook processing deferred to internal retry:', error.message);
        return { processed: false, error };
    }
}

async function processWebhook(rawBody, contentType = '') {
    const payload = parseCallback(rawBody, contentType);
    const { providerId } = await authenticateCallback(payload);
    const callbackFields = operationFields(payload);
    const marker = String(payload?.updated_at || payload?.created_at || payload?.date || '').slice(0, 80);
    const eventId = `operation:${providerId}:${callbackFields.status || 'unknown'}:${marker}`;
    const eventRow = await lifecycle.beginPaymentEvent({
        provider: 'plisio',
        eventId,
        eventType: `operation.${callbackFields.status || 'unknown'}`,
        payload
    });
    if (!eventRow) return { duplicate: true, status: callbackFields.status };
    const result = await processClaimedCallback(eventRow, payload);
    return {
        duplicate: false,
        status: result.status || callbackFields.status,
        ...result,
        processingError: result.processed ? null : String(result.error?.message || result.error || 'processing failed')
    };
}

async function retryPaymentEvent(eventRow) {
    if (!eventRow || eventRow.provider !== 'plisio') throw new Error('Plisio retry received the wrong payment event.');
    const payload = eventRow.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Stored Plisio payment event payload is invalid.');
    return processClaimedCallback(eventRow, payload);
}

async function confirmCheckout(providerTxnId, intent) {
    const { remote } = await verifiedRemoteOperation(providerTxnId, intent);
    return applyRemoteOperation(remote, intent);
}

module.exports = { API_BASE, enabled, api, createCheckout, getOperation, parseCallback, callbackDigest, moneyMinor, operationFields, processWebhook, retryPaymentEvent, confirmCheckout, applyRemoteOperation, authenticateCallback, verifiedRemoteOperation, safeEqual };
