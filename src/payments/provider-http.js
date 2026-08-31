'use strict';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

class ProviderHttpError extends Error {
  constructor(message, { provider, code = 'provider_http_error', status = null, retryable = false, requestId = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ProviderHttpError';
    this.provider = provider || null;
    this.code = code;
    this.status = status == null ? null : Number(status);
    this.retryable = Boolean(retryable);
    this.requestId = requestId || null;
  }
}

function boundedTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(50, Math.min(120000, Math.round(parsed)));
}

function timeoutMs(provider) {
  const key = `${String(provider || '').toUpperCase()}_HTTP_TIMEOUT_MS`;
  return boundedTimeout(process.env[key], boundedTimeout(process.env.PAYMENT_PROVIDER_HTTP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS));
}

function retryableStatus(status) {
  const value = Number(status);
  return value === 408 || value === 425 || value === 429 || value >= 500;
}

function requestIdFromHeaders(provider, headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const names = String(provider || '').toLowerCase() === 'paypal'
    ? ['paypal-debug-id', 'x-request-id', 'request-id']
    : ['x-request-id', 'request-id'];
  for (const name of names) {
    const value = String(headers.get(name) || '').trim();
    if (value) return value.slice(0, 200);
  }
  return null;
}

async function readTextBounded(response, maxBytes = DEFAULT_MAX_RESPONSE_BYTES) {
  const limit = Math.max(1024, Number(maxBytes) || DEFAULT_MAX_RESPONSE_BYTES);
  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new ProviderHttpError('Provider response exceeded the allowed size.', { code: 'response_too_large', status: response?.status, retryable: false });
  if (response?.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => {});
        throw new ProviderHttpError('Provider response exceeded the allowed size.', { code: 'response_too_large', status: response?.status, retryable: false });
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > limit) throw new ProviderHttpError('Provider response exceeded the allowed size.', { code: 'response_too_large', status: response?.status, retryable: false });
  return text;
}

async function readJsonBounded(response, maxBytes = DEFAULT_MAX_RESPONSE_BYTES) {
  const text = await readTextBounded(response, maxBytes);
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

function clean(value, max = 500) { return String(value == null ? '' : value).trim().slice(0, max); }
function normalizeLegacyPayPalAgreement(agreement) {
  const state = clean(agreement?.state, 60).toUpperCase();
  const nextBillingTime = clean(agreement?.agreement_details?.next_billing_date, 100) || null;
  const payer = agreement?.payer?.payer_info || {};
  return {
    id: clean(agreement?.id, 255),
    status: state,
    plan_id: clean(agreement?.plan?.id, 255) || null,
    start_time: clean(agreement?.start_date, 100) || null,
    subscriber: {
      payer_id: clean(payer?.payer_id, 255) || null,
      email_address: clean(payer?.email, 320) || null
    },
    billing_info: nextBillingTime ? { next_billing_time: nextBillingTime } : {},
    legacy_api_family: 'billing-agreements-v1'
  };
}
function paypalLegacyFallback(url, options, status) {
  if (![404, 422].includes(Number(status))) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (!['api-m.paypal.com', 'api-m.sandbox.paypal.com'].includes(parsed.hostname)) return null;
  const match = parsed.pathname.match(/^\/v1\/billing\/subscriptions\/(I-[A-Za-z0-9-]+)(\/cancel)?$/i);
  if (!match) return null;
  const method = String(options?.method || 'GET').toUpperCase();
  const id = match[1], cancel = Boolean(match[2]);
  if (!cancel && method === 'GET') {
    return {
      url: `${parsed.origin}/v1/payments/billing-agreements/${encodeURIComponent(id)}`,
      options,
      normalize: normalizeLegacyPayPalAgreement
    };
  }
  if (cancel && method === 'POST') {
    let reason = 'Recurring payment cancelled by CAPTAiNFiN';
    try {
      const body = typeof options?.body === 'string' ? JSON.parse(options.body) : options?.body;
      reason = clean(body?.reason || body?.note || reason, 128) || reason;
    } catch {}
    return {
      url: `${parsed.origin}/v1/payments/billing-agreements/${encodeURIComponent(id)}/cancel`,
      options: { ...options, body: JSON.stringify({ note: reason }) },
      normalize: value => value || {}
    };
  }
  return null;
}

async function oneFetch(provider, url, options, { maxResponseBytes, fetchImpl, signal }) {
  const response = await fetchImpl(url, { ...options, signal });
  const requestId = requestIdFromHeaders(provider, response.headers);
  let data;
  try {
    data = await readJsonBounded(response, maxResponseBytes);
  } catch (error) {
    if (error instanceof ProviderHttpError) {
      error.provider = provider;
      error.requestId = error.requestId || requestId;
    }
    throw error;
  }
  return { response, data, requestId };
}

async function fetchJson(provider, url, options = {}, { timeout = timeoutMs(provider), maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES, fetchImpl = global.fetch } = {}) {
  const controller = new AbortController();
  const deadline = boundedTimeout(timeout);
  const timer = setTimeout(() => controller.abort(), deadline);
  try {
    let result = await oneFetch(provider, url, options, { maxResponseBytes, fetchImpl, signal: controller.signal });
    if (String(provider || '').toLowerCase() === 'paypal' && !result.response.ok) {
      const fallback = paypalLegacyFallback(url, options, result.response.status);
      if (fallback) {
        const legacy = await oneFetch(provider, fallback.url, fallback.options, { maxResponseBytes, fetchImpl, signal: controller.signal });
        result = { ...legacy, data: legacy.response.ok ? fallback.normalize(legacy.data) : legacy.data, legacyFallback: true };
      }
    }
    return { ...result, deadlineMs: deadline };
  } catch (error) {
    const timedOut = controller.signal.aborted || error?.name === 'AbortError';
    if (timedOut) throw new ProviderHttpError(`${provider} request timed out.`, { provider, code: 'timeout', retryable: true, cause: error });
    if (error instanceof ProviderHttpError) throw error;
    throw new ProviderHttpError(`${provider} request failed.`, { provider, code: 'network_error', retryable: true, cause: error });
  } finally {
    clearTimeout(timer);
  }
}

function responseError(provider, response, data, requestId, fallbackMessage) {
  const status = Number(response?.status || 0) || null;
  const message = String(data?.message || data?.error_description || data?.error || fallbackMessage || `${provider} returned HTTP ${status || 'error'}`).slice(0, 500);
  return new ProviderHttpError(message, { provider, code: 'http_error', status, retryable: retryableStatus(status), requestId });
}

function classifySdkError(provider, error) {
  const status = Number(error?.statusCode || error?.status || error?.raw?.statusCode || 0) || null;
  const code = String(error?.code || error?.type || '').toLowerCase();
  const timeout = code.includes('timeout') || error?.name === 'AbortError';
  return {
    provider,
    code: timeout ? 'timeout' : code || 'provider_error',
    status,
    retryable: timeout || retryableStatus(status) || code.includes('connection') || code.includes('network'),
    requestId: String(error?.requestId || error?.raw?.requestId || '').slice(0, 200) || null
  };
}

function safeErrorFields(error) {
  return {
    provider: error?.provider || null,
    code: error?.code || error?.name || 'error',
    status: error?.status == null ? null : Number(error.status),
    retryable: Boolean(error?.retryable),
    requestId: error?.requestId || null
  };
}

module.exports = { DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RESPONSE_BYTES, ProviderHttpError, boundedTimeout, timeoutMs, retryableStatus, requestIdFromHeaders, readTextBounded, readJsonBounded, fetchJson, responseError, classifySdkError, safeErrorFields, normalizeLegacyPayPalAgreement, paypalLegacyFallback };
