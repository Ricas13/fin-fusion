'use strict';

const crypto = require('crypto');
const networkIdentity = require('../access/network-identity');
const { keyFromEnv } = require('../security/purpose-crypto');
const { query } = require('../db');

const GRANT_PARAM = 'cf_grant';
const GRANT_PREFIX = 'cfedge1';
const EDGE_SECRET_HEADER = 'x-captainfin-edge-secret';
const TOKEN_HEADER = 'X-Emby-Token';
const DEFAULT_TTL_SECONDS = 6 * 60 * 60;
const MIN_TTL_SECONDS = 30 * 60;
const MAX_TTL_SECONDS = 12 * 60 * 60;
const MAX_GRANT_LENGTH = 4096;

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function enabled(env = process.env) {
  return truthy(env.STREMIO_EDGE_AUTH_ENABLED);
}

function grantTtlSeconds(env = process.env) {
  const configured = Number(env.STREMIO_EDGE_GRANT_TTL_SECONDS || DEFAULT_TTL_SECONDS);
  if (!Number.isFinite(configured)) return DEFAULT_TTL_SECONDS;
  return Math.max(MIN_TTL_SECONDS, Math.min(MAX_TTL_SECONDS, Math.round(configured)));
}

function edgeSecret(env = process.env) {
  const value = String(env.STREMIO_EDGE_AUTH_SECRET || '').trim();
  if (value.length < 32) throw new Error('STREMIO_EDGE_AUTH_SECRET must contain at least 32 characters when Stremio edge authorization is enabled.');
  return value;
}

function grantKey() {
  const root = keyFromEnv('JELLYFIN_ENCRYPTION_KEY');
  return crypto.createHmac('sha256', root).update('captainfin:stremio-media-edge-grant:v1').digest();
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length || !a.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function canonicalTarget(input) {
  const url = input instanceof URL ? new URL(input.toString()) : new URL(String(input || ''));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Media edge target must use HTTP or HTTPS.');
  url.username = '';
  url.password = '';
  url.hash = '';
  url.searchParams.delete(GRANT_PARAM);
  url.searchParams.delete('api_key');
  url.searchParams.sort();
  return `${url.protocol}//${url.host.toLowerCase()}${url.pathname}${url.search}`;
}

function sealPayload(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', grantKey(), iv);
  cipher.setAAD(Buffer.from(GRANT_PREFIX, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return [GRANT_PREFIX, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function openPayload(grant) {
  const raw = String(grant || '');
  if (!raw || raw.length > MAX_GRANT_LENGTH) throw new Error('Invalid media grant.');
  const parts = raw.split('.');
  if (parts.length !== 4 || parts[0] !== GRANT_PREFIX) throw new Error('Invalid media grant.');
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const ciphertext = Buffer.from(parts[3], 'base64url');
  if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error('Invalid media grant.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', grantKey(), iv);
  decipher.setAAD(Buffer.from(GRANT_PREFIX, 'utf8'));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  const payload = JSON.parse(plaintext);
  if (!payload || payload.v !== 1 || typeof payload.token !== 'string' || !payload.token) throw new Error('Invalid media grant.');
  return payload;
}

function networkHashForRequest(req) {
  const address = networkIdentity.requestAddress(req);
  const descriptor = networkIdentity.networkDescriptor(address);
  if (!descriptor) throw new Error('A canonical client network is required for protected Stremio media.');
  const hash = networkIdentity.hashNetwork(address);
  if (!hash) throw new Error('A canonical client network is required for protected Stremio media.');
  return hash;
}

function protectUrl(rawUrl, req, { entitlementId = null, nowMs = Date.now() } = {}) {
  if (!enabled()) return String(rawUrl || '');
  const url = new URL(String(rawUrl || ''));
  const token = String(url.searchParams.get('api_key') || '');
  if (!token) return url.toString();
  if (!entitlementId) throw new Error('Current Stremio entitlement is required for protected media.');
  url.searchParams.delete('api_key');
  url.searchParams.delete(GRANT_PARAM);

  const issuedAt = Math.floor(Number(nowMs) / 1000);
  const expiresAt = issuedAt + grantTtlSeconds();
  const payload = {
    v: 1,
    iat: issuedAt,
    exp: expiresAt,
    net: networkHashForRequest(req),
    target: digest(canonicalTarget(url)),
    token,
    entitlement: String(entitlementId).slice(0, 80)
  };
  url.searchParams.set(GRANT_PARAM, sealPayload(payload));
  return url.toString();
}

function protectStreams(streams, req, entitlement) {
  if (!enabled()) return Array.isArray(streams) ? streams.map(stream => ({ ...stream })) : [];
  if (!entitlement?.id) throw new Error('Current Stremio entitlement is required for protected streams.');
  return (Array.isArray(streams) ? streams : []).map(stream => ({
    ...stream,
    url: stream?.url ? protectUrl(stream.url, req, { entitlementId: entitlement.id }) : stream?.url
  }));
}

function firstHeader(req, name) {
  const value = req?.get ? req.get(name) : req?.headers?.[String(name).toLowerCase()];
  return String(value || '').split(',')[0].trim();
}

function forwardedTarget(req) {
  const host = firstHeader(req, 'x-forwarded-host');
  const proto = firstHeader(req, 'x-forwarded-proto').toLowerCase();
  const uri = firstHeader(req, 'x-forwarded-uri');
  if (!host || !/^[a-z0-9.:[\]-]+$/i.test(host)) throw new Error('Missing forwarded media host.');
  if (!['http', 'https'].includes(proto)) throw new Error('Missing forwarded media protocol.');
  if (!uri.startsWith('/') || uri.startsWith('//')) throw new Error('Missing forwarded media URI.');
  const url = new URL(`${proto}://${host}${uri}`);
  if (url.searchParams.has('api_key')) throw new Error('Protected media requests must not expose Jellyfin API keys in the URL.');
  const grants = url.searchParams.getAll(GRANT_PARAM);
  if (grants.length !== 1 || !grants[0]) throw new Error('Missing media grant.');
  const grant = grants[0];
  url.searchParams.delete(GRANT_PARAM);
  return { grant, target: canonicalTarget(url) };
}

function verifyGrant(grant, { target, req, nowMs = Date.now() } = {}) {
  const payload = openPayload(grant);
  const now = Math.floor(Number(nowMs) / 1000);
  const issuedAt = Number(payload.iat || 0);
  const expiresAt = Number(payload.exp || 0);
  if (!Number.isInteger(issuedAt) || !Number.isInteger(expiresAt) || issuedAt <= 0 || expiresAt <= issuedAt) throw new Error('Invalid media grant lifetime.');
  if (issuedAt > now + 60) throw new Error('Media grant is not active yet.');
  if (expiresAt <= now) throw new Error('Media grant expired.');
  if (expiresAt - issuedAt > MAX_TTL_SECONDS + 60) throw new Error('Media grant lifetime is invalid.');
  if (!safeEqual(payload.net, networkHashForRequest(req))) throw new Error('Media grant network mismatch.');
  if (!safeEqual(payload.target, digest(target))) throw new Error('Media grant target mismatch.');
  if (!payload.entitlement) throw new Error('Media grant is not bound to an entitlement.');
  return payload;
}

function edgeSecretMatches(req) {
  try {
    return safeEqual(firstHeader(req, EDGE_SECRET_HEADER), edgeSecret());
  } catch (_) {
    return false;
  }
}

function authorize(req, { nowMs = Date.now() } = {}) {
  if (!enabled()) return { allowed: false, status: 404, reason: 'disabled' };
  if (!edgeSecretMatches(req)) return { allowed: false, status: 401, reason: 'edge_secret' };
  const method = (firstHeader(req, 'x-forwarded-method') || String(req?.method || '')).toUpperCase();
  if (!['GET', 'HEAD'].includes(method)) return { allowed: false, status: 405, reason: 'method' };
  try {
    const { grant, target } = forwardedTarget(req);
    const payload = verifyGrant(grant, { target, req, nowMs });
    return { allowed: true, status: 204, token: payload.token, entitlementId: payload.entitlement };
  } catch (error) {
    return { allowed: false, status: 403, reason: String(error?.message || 'invalid_grant').slice(0, 120) };
  }
}

async function entitlementActive(entitlementId) {
  if (!entitlementId) return false;
  const result = await query(`WITH effective AS (
      SELECT customer_id,subscription_id,access_expires_at,blocked FROM effective_stremio_entitlements
      UNION ALL
      SELECT a.customer_id,a.subscription_id,a.access_expires_at,public.subscription_access_blocked(s.customer_id,s.source,s.provider_subscription_id) AS blocked
      FROM effective_customer_addons a JOIN subscriptions s ON s.id=a.subscription_id
    )
    SELECT EXISTS(
      SELECT 1 FROM stremio_entitlements e
      JOIN effective ee ON ee.customer_id=e.customer_id AND ee.subscription_id=e.subscription_id
      WHERE e.id=$1 AND e.status='active' AND ee.blocked=FALSE AND ee.access_expires_at>NOW()
    ) AS active`, [entitlementId]);
  return result.rows[0]?.active === true;
}

async function authorizeHandler(req, res) {
  const result = authorize(req);
  res.setHeader('Cache-Control', 'no-store');
  if (!result.allowed) return res.status(result.status).end();
  try {
    if (!await entitlementActive(result.entitlementId)) return res.status(403).end();
  } catch (error) {
    console.error('Stremio edge entitlement verification failed:', String(error?.message || error).slice(0, 300));
    return res.status(503).end();
  }
  res.setHeader(TOKEN_HEADER, result.token);
  return res.status(204).end();
}

function noCacheStreamResponse(body) {
  if (!body || !Array.isArray(body.streams)) return body;
  return {
    ...body,
    cacheMaxAge: 0,
    staleRevalidate: 0,
    staleError: 0
  };
}

function requestInstallToken(req) {
  const match = String(req.path || '').match(/^\/stremio\/([^/]+)\/(?:stream|play|external-play)\//);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch (_) { return null; }
}

async function requestEntitlement(req) {
  const token = requestInstallToken(req);
  if (!token) return null;
  return require('./entitlements').findByInstallToken(token);
}

function runtimeProtectionMiddleware(req, res, next) {
  const requestPath = String(req.path || '');
  if (/^\/stremio\/[^/]+\/stream\/[^/]+\/[^/]+\.json$/.test(requestPath)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const sendJson = res.json.bind(res);
    res.json = async body => {
      const uncachedBody = noCacheStreamResponse(body);
      if (!uncachedBody || !Array.isArray(uncachedBody.streams) || !uncachedBody.streams.length || !enabled()) return sendJson(uncachedBody);
      try {
        const entitlement = await requestEntitlement(req);
        if (!entitlement) return sendJson(noCacheStreamResponse({ streams: [] }));
        return sendJson({ ...uncachedBody, streams: protectStreams(uncachedBody.streams, req, entitlement) });
      } catch (error) {
        console.error('Stremio edge grant issuance failed:', String(error?.message || error).slice(0, 300));
        return sendJson(noCacheStreamResponse({ streams: [] }));
      }
    };
  }
  if (!enabled()) return next();
  if (/^\/stremio\/[^/]+\/(?:play|external-play)\//.test(requestPath)) {
    const redirect = res.redirect.bind(res);
    res.redirect = async (statusOrUrl, maybeUrl) => {
      const hasStatus = typeof statusOrUrl === 'number';
      const target = hasStatus ? maybeUrl : statusOrUrl;
      try {
        const entitlement = await requestEntitlement(req);
        if (!entitlement) return res.status(403).end();
        const protectedTarget = protectUrl(target, req, { entitlementId: entitlement.id });
        return hasStatus ? redirect(statusOrUrl, protectedTarget) : redirect(protectedTarget);
      } catch (error) {
        console.error('Stremio edge compatibility grant issuance failed:', String(error?.message || error).slice(0, 300));
        return res.status(502).end();
      }
    };
  }
  return next();
}

module.exports = {
  GRANT_PARAM,
  GRANT_PREFIX,
  EDGE_SECRET_HEADER,
  TOKEN_HEADER,
  DEFAULT_TTL_SECONDS,
  MIN_TTL_SECONDS,
  MAX_TTL_SECONDS,
  enabled,
  grantTtlSeconds,
  edgeSecret,
  canonicalTarget,
  sealPayload,
  openPayload,
  networkHashForRequest,
  protectUrl,
  protectStreams,
  forwardedTarget,
  verifyGrant,
  edgeSecretMatches,
  authorize,
  entitlementActive,
  authorizeHandler,
  noCacheStreamResponse,
  requestInstallToken,
  requestEntitlement,
  runtimeProtectionMiddleware
};
