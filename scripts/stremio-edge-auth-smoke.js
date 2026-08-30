'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const previous = {
  STREMIO_EDGE_AUTH_ENABLED: process.env.STREMIO_EDGE_AUTH_ENABLED,
  STREMIO_EDGE_AUTH_SECRET: process.env.STREMIO_EDGE_AUTH_SECRET,
  STREMIO_EDGE_GRANT_TTL_SECONDS: process.env.STREMIO_EDGE_GRANT_TTL_SECONDS,
  JELLYFIN_ENCRYPTION_KEY: process.env.JELLYFIN_ENCRYPTION_KEY,
  HOUSEHOLD_NETWORK_HASH_KEY: process.env.HOUSEHOLD_NETWORK_HASH_KEY
};

process.env.STREMIO_EDGE_AUTH_ENABLED = 'true';
process.env.STREMIO_EDGE_AUTH_SECRET = 'edge-secret-'.padEnd(64, 'x');
process.env.STREMIO_EDGE_GRANT_TTL_SECONDS = '21600';
process.env.JELLYFIN_ENCRYPTION_KEY = '11'.repeat(32);
process.env.HOUSEHOLD_NETWORK_HASH_KEY = 'household-network-key-'.padEnd(64, 'h');

function req(ip, headers = {}, method = 'GET') {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ip,
    method,
    headers: normalized,
    get(name) { return normalized[String(name).toLowerCase()] || ''; }
  };
}

try {
  const edge = require('../src/stremio/media-edge-grant');
  const client = req('8.8.8.8');
  const raw = 'https://jellyfin.example.com/Videos/item-1/stream.mkv?Static=true&MediaSourceId=source-1&api_key=restricted-jellyfin-token';
  assert.throws(
    () => edge.protectUrl(raw, client),
    /Current Stremio entitlement is required/,
    'protected media grants must never be issued without an entitlement identity'
  );
  const protectedUrl = edge.protectUrl(raw, client, { entitlementId: 'entitlement-1' });
  const parsed = new URL(protectedUrl);
  assert.strictEqual(parsed.origin, 'https://jellyfin.example.com');
  assert.strictEqual(parsed.pathname, '/Videos/item-1/stream.mkv');
  assert.strictEqual(parsed.searchParams.get('Static'), 'true');
  assert.strictEqual(parsed.searchParams.get('MediaSourceId'), 'source-1');
  assert.strictEqual(parsed.searchParams.has('api_key'), false, 'protected URL must not expose the Jellyfin token');
  assert.match(parsed.searchParams.get(edge.GRANT_PARAM), /^cfedge1\./, 'protected URL must carry an opaque edge grant');
  assert(!protectedUrl.includes('restricted-jellyfin-token'), 'Jellyfin token must not be visible in the Stremio URL');

  const forwardedHeaders = {
    'x-captainfin-edge-secret': process.env.STREMIO_EDGE_AUTH_SECRET,
    'x-forwarded-method': 'GET',
    'x-forwarded-proto': parsed.protocol.replace(':', ''),
    'x-forwarded-host': parsed.host,
    'x-forwarded-uri': `${parsed.pathname}${parsed.search}`
  };
  const allowed = edge.authorize(req('8.8.8.8', forwardedHeaders));
  assert.strictEqual(allowed.allowed, true);
  assert.strictEqual(allowed.status, 204);
  assert.strictEqual(allowed.token, 'restricted-jellyfin-token');
  assert.strictEqual(allowed.entitlementId, 'entitlement-1', 'edge authorization must retain the bound entitlement identity for live verification');

  const replayedElsewhere = edge.authorize(req('1.1.1.1', forwardedHeaders));
  assert.strictEqual(replayedElsewhere.allowed, false);
  assert.strictEqual(replayedElsewhere.status, 403, 'grant replay from another IPv4 household must fail');

  const tamperedHeaders = { ...forwardedHeaders, 'x-forwarded-uri': forwardedHeaders['x-forwarded-uri'].replace('item-1', 'item-2') };
  const tampered = edge.authorize(req('8.8.8.8', tamperedHeaders));
  assert.strictEqual(tampered.allowed, false);
  assert.strictEqual(tampered.status, 403, 'grant must be bound to exact media target');

  const missingSecret = { ...forwardedHeaders };
  delete missingSecret['x-captainfin-edge-secret'];
  const unauthenticatedEdge = edge.authorize(req('8.8.8.8', missingSecret));
  assert.strictEqual(unauthenticatedEdge.status, 401, 'public callers must not be able to retrieve Jellyfin tokens from edge auth');

  const expiredUrl = edge.protectUrl(raw, client, { entitlementId: 'entitlement-1', nowMs: Date.now() - 7 * 60 * 60 * 1000 });
  const expiredParsed = new URL(expiredUrl);
  const expiredHeaders = {
    ...forwardedHeaders,
    'x-forwarded-uri': `${expiredParsed.pathname}${expiredParsed.search}`
  };
  const expired = edge.authorize(req('8.8.8.8', expiredHeaders));
  assert.strictEqual(expired.allowed, false);
  assert.strictEqual(expired.status, 403, 'expired media grants must fail closed');

  const ipv6Protected = edge.protectUrl(raw, req('2001:4860:4860:0000::1234'), { entitlementId: 'entitlement-1' });
  const ipv6Parsed = new URL(ipv6Protected);
  const ipv6Headers = {
    'x-captainfin-edge-secret': process.env.STREMIO_EDGE_AUTH_SECRET,
    'x-forwarded-method': 'HEAD',
    'x-forwarded-proto': 'https',
    'x-forwarded-host': ipv6Parsed.host,
    'x-forwarded-uri': `${ipv6Parsed.pathname}${ipv6Parsed.search}`
  };
  assert.strictEqual(edge.authorize(req('2001:4860:4860:0000::abcd', ipv6Headers), { nowMs: Date.now() }).allowed, true, 'IPv6 devices inside the same /64 should share the household grant');
  assert.strictEqual(edge.authorize(req('2001:4860:4861:0000::abcd', ipv6Headers), { nowMs: Date.now() }).allowed, false, 'IPv6 replay outside the bound /64 must fail');

  const localBlocked = 'https://captainfin.example.com/stremio/token/household-blocked/movie/tt1234567.mp4';
  assert.strictEqual(edge.protectUrl(localBlocked, client), localBlocked, 'non-Jellyfin explanatory streams must remain untouched');

  const runtime = fs.readFileSync(path.join(__dirname, '..', 'src', 'stremio', 'runtime.js'), 'utf8');
  assert(runtime.includes("require('./media-edge-grant')"));
  assert(runtime.includes("router.all('/stremio-edge/authorize', mediaEdge.authorizeHandler)"));
  assert(runtime.includes('router.use(mediaEdge.runtimeProtectionMiddleware)'));
  const edgeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'stremio', 'media-edge-grant.js'), 'utf8');
  assert(edgeSource.includes('if (!await entitlementActive(result.entitlementId)) return res.status(403).end();'), 'edge auth must re-check live entitlement state before returning a Jellyfin token');
  assert(edgeSource.includes("ee.blocked=FALSE AND ee.access_expires_at>NOW()"), 'live edge verification must reject blocked or expired entitlements');

  const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  assert.strictEqual((compose.match(/^\s+STREMIO_EDGE_AUTH_SECRET:/gm) || []).length, 1, 'edge shared secret must only be passed to the web runtime');
  assert(compose.includes('STREMIO_EDGE_AUTH_ENABLED: ${STREMIO_EDGE_AUTH_ENABLED:-false}'));

  const docs = fs.readFileSync(path.join(__dirname, '..', 'docs', 'STREMIO_EDGE_AUTH.md'), 'utf8');
  assert(docs.includes('forwardAuth'));
  assert(docs.includes('X-Emby-Token'));
  assert(docs.includes('CAPTAiNFiN never receives or relays media bytes'));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'captainfin-edge-env-'));
  try {
    const envFile = path.join(tempDir, '.env');
    fs.writeFileSync(envFile, [
      'DATABASE_URL=postgres://steamfusion:owner-password-long-enough@postgres:5432/steamfusion',
      'POSTGRES_PASSWORD=owner-password-long-enough',
      'APP_DATABASE_URL=postgres://steamfusion_app:app-password-long-enough-123456@postgres:5432/steamfusion',
      'AUTOMATION_DATABASE_URL=postgres://steamfusion_automation:auto-password-long-enough-12345@postgres:5432/steamfusion',
      'ACTIVITY_DATABASE_URL=postgres://steamfusion_activity:activity-password-long-enough-12@postgres:5432/steamfusion',
      'BACKUP_DATABASE_URL=postgres://steamfusion_backup:backup-password-long-enough-1234@postgres:5432/steamfusion',
      'BACKUP_VERIFY_DATABASE_URL=postgres://steamfusion_backup_verify:verify-password-long-enough-1234@postgres:5432/steamfusion',
      'STREMIO_EDGE_AUTH_ENABLED=true',
      'STREMIO_EDGE_AUTH_SECRET=',
      'STREMIO_EDGE_GRANT_TTL_SECONDS=21600',
      ''
    ].join('\n'), { mode: 0o600 });
    const prepared = spawnSync(process.execPath, [path.join(__dirname, 'prepare-production-env.js'), '--write', `--env-file=${envFile}`], { encoding: 'utf8' });
    assert.strictEqual(prepared.status, 0, prepared.stderr || prepared.stdout);
    const generated = fs.readFileSync(envFile, 'utf8').match(/^STREMIO_EDGE_AUTH_SECRET=(.+)$/m)?.[1] || '';
    assert(generated.length >= 32, 'deployment preflight must generate a strong edge secret when protection is enabled');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('stremio edge authorization smoke: ok');
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
