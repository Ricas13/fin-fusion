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
  return Math.max(1000, Math.min(120000, Math.round(parsed)));
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

async function fetchJson(provider, url, options = {}, { timeout = timeoutMs(provider), maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES, fetchImpl = global.fetch } = {}) {
  const controller = new AbortController();
  const deadline = boundedTimeout(timeout);
  const timer = setTimeout(() => controller.abort(), deadline);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal: controller.signal });
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
    return { response, data, requestId, deadlineMs: deadline };
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

module.exports = { DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RESPONSE_BYTES, ProviderHttpError, boundedTimeout, timeoutMs, retryableStatus, requestIdFromHeaders, readTextBounded, readJsonBounded, fetchJson, responseError, classifySdkError, safeErrorFields };
