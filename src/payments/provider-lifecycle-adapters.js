'use strict';

const buildInfo = require('../build-info');
const providerSettings = require('./provider-settings');
const providerHttp = require('./provider-http');
const providerLifecycleState = require('./provider-lifecycle-state');

let stripeClient = null;
let stripeClientKey = null;
let paypalToken = null;
let paypalTokenUntil = 0;
let paypalCredentialKey = null;

const REQUIRED_METHODS = Object.freeze(['fetchRemote','stopRenewal','resumeRenewal','terminate']);

function providerMissing(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  const code = String(error?.code || '').toLowerCase();
  const detail = String(error?.message || error || '');
  return status === 404
    || code === 'resource_missing'
    || /no such subscription|\b404\b[^\n]*\bsubscription\b|\bsubscription\b[^\n]*\b404\b/i.test(detail);
}

function stripePeriod(subscription) {
  const items = subscription?.items?.data || [];
  const ends = items.map(item => Number(item.current_period_end)).filter(Number.isFinite);
  const end = ends.length ? Math.max(...ends) : Number(subscription?.current_period_end);
  return Number.isFinite(end) ? new Date(end * 1000) : null;
}

function stripePriceId(subscription) {
  const price = subscription?.items?.data?.[0]?.price;
  return typeof price === 'string' ? price : price?.id || null;
}

function assertAdapter(provider, adapter) {
  if (!adapter || typeof adapter !== 'object') throw new Error(`Recurring ${provider} lifecycle adapter is unavailable.`);
  const missing = REQUIRED_METHODS.filter(method => typeof adapter[method] !== 'function');
  if (missing.length) throw new Error(`Recurring ${provider} lifecycle adapter is missing: ${missing.join(', ')}.`);
  return adapter;
}

async function stripeAdapter() {
  const cfg = await providerSettings.get('stripe');
  const key = cfg.restrictedKey || cfg.apiKey || '';
  if (!key) throw new Error('Stripe is disabled or not configured.');
  if (!stripeClient || stripeClientKey !== key) {
    const Stripe = require('stripe');
    stripeClient = new Stripe(key, {
      apiVersion: '2026-06-24.dahlia',
      appInfo: buildInfo.providerAppInfo(),
      timeout: providerHttp.timeoutMs('stripe')
    });
    stripeClientKey = key;
  }
  return assertAdapter('stripe', {
    async fetchRemote(row) {
      const subscription = await stripeClient.subscriptions.retrieve(
        row.provider_subscription_id,
        { expand: ['items.data.price'] }
      );
      return {
        status: subscription.status,
        periodEnd: stripePeriod(subscription),
        cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
        priceId: stripePriceId(subscription)
      };
    },
    async stopRenewal(row, { idempotencyKey = null } = {}) {
      await stripeClient.subscriptions.update(
        row.provider_subscription_id,
        { cancel_at_period_end: true },
        idempotencyKey ? { idempotencyKey } : undefined
      );
    },
    async resumeRenewal(row, { idempotencyKey = null } = {}) {
      await stripeClient.subscriptions.update(
        row.provider_subscription_id,
        { cancel_at_period_end: false },
        idempotencyKey ? { idempotencyKey } : undefined
      );
    },
    async terminate(row, { idempotencyKey = null } = {}) {
      try {
        let subscription = await stripeClient.subscriptions.retrieve(
          row.provider_subscription_id,
          { expand: ['items.data.price'] }
        );
        if (providerLifecycleState.isTerminal('stripe', subscription?.status)) {
          return { status: 'cancelled', remoteStatus: providerLifecycleState.normalizeStatus('stripe', subscription?.status) };
        }
        subscription = await stripeClient.subscriptions.cancel(
          row.provider_subscription_id,
          { invoice_now: false, prorate: false },
          idempotencyKey ? { idempotencyKey } : undefined
        );
        let remoteStatus = providerLifecycleState.normalizeStatus('stripe', subscription?.status);
        if (!providerLifecycleState.isTerminal('stripe', remoteStatus)) {
          subscription = await stripeClient.subscriptions.retrieve(
            row.provider_subscription_id,
            { expand: ['items.data.price'] }
          );
          remoteStatus = providerLifecycleState.normalizeStatus('stripe', subscription?.status);
        }
        if (!providerLifecycleState.isTerminal('stripe', remoteStatus)) {
          throw new Error(`Stripe subscription ${row.provider_subscription_id} is still ${remoteStatus || 'non-terminal'} after cancellation.`);
        }
        return { status: 'cancelled', remoteStatus };
      } catch (error) {
        if (providerMissing(error)) return { status: 'already_missing', remoteStatus: 'missing' };
        throw error;
      }
    }
  });
}

function paypalBaseUrl(cfg) {
  return cfg.environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

function paypalHttpError(response, payload, requestId, prefix = 'PayPal HTTP') {
  const detail = payload?.message || payload?.name || payload?.error_description || 'request failed';
  const error = providerHttp.responseError('paypal', response, payload, requestId, `${prefix} ${response.status}: ${detail}`);
  error.message = `${prefix} ${response.status}: ${detail}`;
  return error;
}

async function paypalAccessToken() {
  const cfg = await providerSettings.get('paypal');
  if (!cfg.clientId || !cfg.clientSecret) throw new Error('PayPal is disabled or not configured.');
  const credentialKey = `${cfg.environment || 'sandbox'}:${cfg.clientId}:${cfg.clientSecret}`;
  if (credentialKey !== paypalCredentialKey) {
    paypalCredentialKey = credentialKey;
    paypalToken = null;
    paypalTokenUntil = 0;
  }
  if (paypalToken && Date.now() < paypalTokenUntil - 60000) return { cfg, token: paypalToken };
  const { response, data: payload, requestId } = await providerHttp.fetchJson(
    'paypal',
    `${paypalBaseUrl(cfg)}/v1/oauth2/token`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    }
  );
  if (!response.ok || !payload.access_token) {
    throw paypalHttpError(response, payload, requestId, 'PayPal OAuth failed:');
  }
  paypalToken = payload.access_token;
  paypalTokenUntil = Date.now() + Number(payload.expires_in || 300) * 1000;
  return { cfg, token: paypalToken };
}

async function paypalApi(path, { method = 'GET', body = null, idempotencyKey = null } = {}) {
  const { cfg, token } = await paypalAccessToken();
  const result = await providerHttp.fetchJson('paypal', `${paypalBaseUrl(cfg)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(idempotencyKey ? { 'PayPal-Request-Id': String(idempotencyKey).slice(0, 108) } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const payload = result.data || {};
  if (!result.response.ok) throw paypalHttpError(result.response, payload, result.requestId);
  return payload;
}

async function paypalAdapter() {
  await paypalAccessToken();
  return assertAdapter('paypal', {
    async fetchRemote(row) {
      const subscription = await paypalApi(
        `/v1/billing/subscriptions/${encodeURIComponent(row.provider_subscription_id)}`
      );
      const status = providerLifecycleState.normalizeStatus('paypal', subscription.status);
      const nextBilling = subscription.billing_info?.next_billing_time
        ? new Date(subscription.billing_info.next_billing_time)
        : null;
      return {
        status,
        remoteStatus: status,
        periodEnd: nextBilling,
        cancelAtPeriodEnd: ['CANCELLED','CANCELED'].includes(status)
      };
    },
    async stopRenewal(row, { idempotencyKey = null } = {}) {
      await paypalApi(
        `/v1/billing/subscriptions/${encodeURIComponent(row.provider_subscription_id)}/cancel`,
        {
          method: 'POST',
          body: { reason: 'Renewal disabled by CAPTAiNFiN administrator' },
          idempotencyKey
        }
      );
    },
    async resumeRenewal() {
      throw new Error('A cancelled PayPal subscription cannot be resumed automatically. The customer must start a new PayPal subscription.');
    },
    async terminate(row, { idempotencyKey = null } = {}) {
      try {
        let subscription = await paypalApi(
          `/v1/billing/subscriptions/${encodeURIComponent(row.provider_subscription_id)}`
        );
        let remoteStatus = providerLifecycleState.normalizeStatus('paypal', subscription?.status);
        if (providerLifecycleState.isTerminal('paypal', remoteStatus)) {
          return { status: 'cancelled', remoteStatus };
        }
        await paypalApi(
          `/v1/billing/subscriptions/${encodeURIComponent(row.provider_subscription_id)}/cancel`,
          {
            method: 'POST',
            body: { reason: 'Customer account hard-deleted in CAPTAiNFiN' },
            idempotencyKey
          }
        );
        subscription = await paypalApi(
          `/v1/billing/subscriptions/${encodeURIComponent(row.provider_subscription_id)}`
        );
        remoteStatus = providerLifecycleState.normalizeStatus('paypal', subscription?.status);
        if (!providerLifecycleState.isTerminal('paypal', remoteStatus)) {
          throw new Error(`PayPal subscription ${row.provider_subscription_id} is still ${remoteStatus || 'non-terminal'} after cancellation.`);
        }
        return { status: 'cancelled', remoteStatus };
      } catch (error) {
        if (providerMissing(error)) return { status: 'already_missing', remoteStatus: 'MISSING' };
        throw error;
      }
    }
  });
}

async function forProvider(provider) {
  const name = providerLifecycleState.providerName(provider);
  if (name === 'stripe') return stripeAdapter();
  if (name === 'paypal') return paypalAdapter();
  throw new Error('Unsupported recurring payment provider.');
}

module.exports = {
  REQUIRED_METHODS,
  providerMissing,
  stripePeriod,
  stripePriceId,
  assertAdapter,
  stripeAdapter,
  paypalBaseUrl,
  paypalHttpError,
  paypalAccessToken,
  paypalApi,
  paypalAdapter,
  forProvider
};
