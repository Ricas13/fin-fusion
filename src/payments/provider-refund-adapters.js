'use strict';

const Stripe = require('stripe');
const buildInfo = require('../build-info');
const providerSettings = require('./provider-settings');
const providerHttp = require('./provider-http');
const providerLifecycleState = require('./provider-lifecycle-state');

function normalizeRefundStatus(provider, status) {
  const name = providerLifecycleState.providerName(provider);
  const value = String(status || '').trim();
  return name === 'paypal' ? value.toLowerCase() : value.toLowerCase();
}

function refundComplete(provider, status) {
  const name = providerLifecycleState.providerName(provider);
  const normalized = normalizeRefundStatus(name, status);
  if (name === 'stripe') return normalized === 'succeeded';
  if (name === 'paypal') return normalized === 'completed';
  return false;
}

async function stripeClient() {
  const cfg = await providerSettings.get('stripe');
  const key = cfg.restrictedKey || cfg.apiKey || '';
  if (!key) throw new Error('Stripe is not configured.');
  return new Stripe(key, {
    apiVersion: '2026-06-24.dahlia',
    appInfo: buildInfo.providerAppInfo(),
    timeout: providerHttp.timeoutMs('stripe')
  });
}

function paypalBaseUrl(config) {
  return config.environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

async function paypalSession() {
  const cfg = await providerSettings.get('paypal');
  if (!cfg.clientId || !cfg.clientSecret) throw new Error('PayPal is not configured.');
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const result = await providerHttp.fetchJson('paypal', `${paypalBaseUrl(cfg)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!result.response.ok || !result.data?.access_token) {
    throw providerHttp.responseError(
      'paypal',
      result.response,
      result.data,
      result.requestId,
      'PayPal authentication failed.'
    );
  }
  return { cfg, token: result.data.access_token };
}

async function paypalRequest(path, { method = 'GET', body = null, idempotencyKey = null } = {}) {
  const { cfg, token } = await paypalSession();
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
  if (!result.response.ok) {
    throw providerHttp.responseError(
      'paypal',
      result.response,
      result.data,
      result.requestId,
      `PayPal refund request failed (${result.response.status}).`
    );
  }
  return result.data || {};
}

async function stripeRefund(op, request) {
  const client = await stripeClient();
  let refund;
  if (op.provider_reference) {
    refund = await client.refunds.retrieve(op.provider_reference);
  } else {
    refund = await client.refunds.create({
      payment_intent: request.providerReference,
      amount: Number(request.refundMinor),
      metadata: {
        captainfin_operation_id: String(op.id),
        captainfin_subscription_id: String(request.subscriptionId),
        reason: String(request.reason || '').slice(0, 250)
      }
    }, { idempotencyKey: op.idempotency_key });
  }
  return {
    id: refund.id,
    status: normalizeRefundStatus('stripe', refund.status),
    raw: {
      status: refund.status || null,
      paymentIntent: refund.payment_intent || request.providerReference
    }
  };
}

async function paypalRefund(op, request) {
  let refund;
  if (op.provider_reference) {
    refund = await paypalRequest(`/v2/payments/refunds/${encodeURIComponent(op.provider_reference)}`);
  } else {
    refund = await paypalRequest(
      `/v2/payments/captures/${encodeURIComponent(request.providerReference)}/refund`,
      {
        method: 'POST',
        idempotencyKey: op.idempotency_key,
        body: {
          amount: {
            value: (Number(request.refundMinor) / 100).toFixed(2),
            currency_code: request.currency
          }
        }
      }
    );
  }
  return {
    id: refund.id,
    status: normalizeRefundStatus('paypal', refund.status),
    raw: {
      status: refund.status || null,
      captureId: request.providerReference
    }
  };
}

function forProvider(provider) {
  const name = providerLifecycleState.providerName(provider);
  if (name === 'stripe') {
    return Object.freeze({
      provider: name,
      createOrObserve: stripeRefund,
      isComplete: status => refundComplete(name, status)
    });
  }
  if (name === 'paypal') {
    return Object.freeze({
      provider: name,
      createOrObserve: paypalRefund,
      isComplete: status => refundComplete(name, status)
    });
  }
  const error = new Error(`Automated provider refunds are not supported for ${name}.`);
  error.code = 'PROVIDER_REFUND_UNSUPPORTED';
  throw error;
}

module.exports = {
  normalizeRefundStatus,
  refundComplete,
  stripeClient,
  paypalBaseUrl,
  paypalSession,
  paypalRequest,
  stripeRefund,
  paypalRefund,
  forProvider
};
