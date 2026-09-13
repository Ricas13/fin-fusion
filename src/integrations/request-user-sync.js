'use strict';

const crypto = require('crypto');
const { query, getPool, transaction } = require('../db');
const requestSettings = require('./request-service-settings');
const planPolicy = require('./request-plan-policy');
const requestEntitlements = require('./request-entitlement');
const outbound = require('../security/outbound-url-policy');
const scanCursor = require('../automation/scan-cursor');

const REQUEST_PERMISSION = planPolicy.DEFAULT_REQUEST_MASK;
const DEFAULT_SYNC_CONCURRENCY = 3;
const MAX_SYNC_CONCURRENCY = 8;
const REQUEST_SCAN_KEY = 'request_users.customers';
const DEFAULT_SYNC_BATCH_SIZE = 250;
const MAX_SYNC_BATCH_SIZE = 1000;
const SEERR_ADMIN_PERMISSION = 2;
const SEERR_MANAGE_USERS_PERMISSION = 8;
const SEERR_PROTECTED_DELETE_MASK = SEERR_ADMIN_PERMISSION | SEERR_MANAGE_USERS_PERMISSION;
const REQUEST_SYNC_LOCK_PREFIX = 'request-user-sync:';
const REQUEST_EXTERNAL_LOCK_PREFIX = 'request-user-external:';
const MANAGED_MAIN_FIELDS = [
  'username','email','locale','discoverRegion','streamingRegion','region','originalLanguage',
  'watchlistSyncMovies','watchlistSyncTv','movieQuotaLimit','movieQuotaDays','tvQuotaLimit','tvQuotaDays'
];

function cleanBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('Enter a valid Overseerr/Seerr URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Requests URL must use http or https.');
  if (parsed.username || parsed.password || parsed.hash) throw new Error('Requests URL may not contain credentials or fragments.');
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}
function requestApiUserId(value = process.env.SEERR_API_USER_ID) {
  const raw = String(value || '').trim();
  return /^[1-9][0-9]*$/.test(raw) ? raw : '';
}
function requestHeaders(apiKey) {
  const apiUserId = requestApiUserId();
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Api-Key': apiKey,
    ...(apiUserId ? { 'X-API-User': apiUserId } : {})
  };
}
async function configuration() {
  const cfg = await requestSettings.get();
  return { baseUrl: cleanBaseUrl(cfg.baseUrl), apiKey: String(cfg.apiKey || '').trim(), configured: Boolean(cfg.enabled && cfg.baseUrl && cfg.apiKey) };
}
async function apiRequest(path, { method = 'GET', body = null, timeoutMs = 10000 } = {}) {
  const config = await configuration();
  if (!config.baseUrl) throw new Error('External request site URL is not configured.');
  if (!config.apiKey) throw new Error('Request-service API key is not configured.');
  if (typeof path !== 'string' || !path.startsWith('/api/v1/') || path.startsWith('//')) throw new Error('Invalid requests API path.');
  const base = new URL(`${config.baseUrl}/`), url = new URL(path, base);
  if (url.origin !== base.origin) throw new Error('Request API path escaped the configured request-service origin.');
  try {
    const response = await outbound.safeFetch(url, { purpose: 'Request service', method, timeoutMs, headers: requestHeaders(config.apiKey), body: body == null ? undefined : JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.message || `Request service returned HTTP ${response.status}`);
      error.statusCode = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Request service request timed out.');
    throw error;
  }
}
function validEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
function cleanUsername(value) {
  const username = String(value || '').trim().replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return username || 'user';
}
function externalIdentity(value) {
  return String(value || '').trim().toLowerCase();
}
function requestLogin(candidate) {
  return externalIdentity(cleanUsername(candidate?.username));
}
function fallbackEmail(customerId) {
  const compact = String(customerId || '').replace(/[^a-f0-9]/gi, '').toLowerCase().slice(0, 24) || crypto.randomBytes(8).toString('hex');
  return `cf-${compact}@captainfin.invalid`;
}
function legacyRequestEmails(candidate) {
  return [...new Set([
    validEmail(candidate?.external_email),
    validEmail(candidate?.email),
    fallbackEmail(candidate?.customer_id)
  ].filter(Boolean))];
}
function sameExternalUser(left, right) {
  return left?.id != null && right?.id != null && String(left.id) === String(right.id);
}
function intentionallyRemoved(candidate) {
  return !candidate?.external_user_id && candidate?.access_suspended === true;
}
function trustedExternalForCandidate(candidate, indexes = {}) {
  if (candidate?.external_user_id) {
    const linked = indexes.byId?.get(String(candidate.external_user_id)) || null;
    if (linked) return linked;
  }
  if (intentionallyRemoved(candidate)) return null;
  for (const email of legacyRequestEmails(candidate)) {
    const linked = indexes.byEmail?.get(externalIdentity(email)) || null;
    if (linked) return linked;
  }
  return null;
}
function loginCollisionForCandidate(candidate, indexes = {}, login, trustedExternal = null) {
  const target = indexes.byEmail?.get(externalIdentity(login)) || null;
  if (!target) return null;
  if (trustedExternal && sameExternalUser(target, trustedExternal)) return null;
  if (candidate?.external_user_id && String(target.id) === String(candidate.external_user_id)) return null;
  return target;
}
function quotaLimit(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : 0; }
function quotaDays(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : 30; }
function syncConcurrency(value = process.env.REQUEST_USER_SYNC_CONCURRENCY) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(MAX_SYNC_CONCURRENCY, parsed) : DEFAULT_SYNC_CONCURRENCY;
}
function syncBatchSize(value = process.env.REQUEST_USER_SYNC_BATCH_SIZE) {
  return scanCursor.boundedInteger(value, DEFAULT_SYNC_BATCH_SIZE, 10, MAX_SYNC_BATCH_SIZE);
}
function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
async function mapBounded(items, limit, mapper) {
  const values = Array.from(items || []), results = new Array(values.length);
  if (!values.length) return results;
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, Number(limit) || 1), values.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  }));
  return results;
}
async function withSessionAdvisoryLock(client, key, fn) {
  await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
  let primaryError = null;
  try {
    return await fn();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      const released = await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked', [key]);
      if (released.rows[0]?.unlocked !== true && !primaryError) throw new Error(`Failed to release request sync lock ${key}.`);
    } catch (unlockError) {
      if (!primaryError) throw unlockError;
    }
  }
}
async function withCustomerSyncLock(customerId, fn) {
  const key = `${REQUEST_SYNC_LOCK_PREFIX}${String(customerId || '').trim()}`;
  const client = await getPool().connect();
  let destroy = false;
  try {
    return await withSessionAdvisoryLock(client, key, () => fn(client));
  } catch (error) {
    if (/release request sync lock/.test(String(error?.message || ''))) destroy = true;
    throw error;
  } finally {
    client.release(destroy);
  }
}
async function withExternalSyncLock(client, externalUserId, fn) {
  if (!client || externalUserId == null) return fn();
  return withSessionAdvisoryLock(client, `${REQUEST_EXTERNAL_LOCK_PREFIX}${String(externalUserId)}`, fn);
}

async function syncCandidates(options = {}) {
  const after = isUuid(options.after) ? options.after : null;
  const requestedIds = Array.isArray(options.ids) ? [...new Set(options.ids.map(String).filter(isUuid))] : [];
  const limit = options.limit == null ? null : scanCursor.boundedInteger(options.limit, DEFAULT_SYNC_BATCH_SIZE, 1, MAX_SYNC_BATCH_SIZE + 1);
  const params = [];
  const where = [];
  if (after) { params.push(after); where.push(`c.id>$${params.length}::uuid`); }
  if (requestedIds.length) { params.push(requestedIds); where.push(`c.id=ANY($${params.length}::uuid[])`); }
  let limitSql = '';
  if (limit !== null) { params.push(limit); limitSql = `LIMIT $${params.length}`; }
  const boundedMode = Boolean(after || requestedIds.length || limit !== null);
  const result = await query(`
    SELECT c.id AS customer_id,
      COALESCE(NULLIF(u.email,''),NULLIF(c.email,'')) AS email,
      COALESCE(NULLIF(u.username,''),NULLIF(c.display_name,''),jf.jellyfin_username,'user') AS username,
      COALESCE(jf.active_server_count,0)::int AS active_server_count,
      jf.active_servers,
      e.plan_id,e.name AS plan_name,e.code AS plan_code,e.access_expires_at AS current_period_end,
      e.request_movie_quota_limit,e.request_movie_quota_days,
      e.request_tv_quota_limit,e.request_tv_quota_days,
      COALESCE(p.request_access_enabled,TRUE) AS request_access_enabled,
      p.request_permissions,cpo.permission_mask AS request_permission_override,p.request_watchlist_sync_movies,p.request_watchlist_sync_tv,
      p.request_locale,p.request_discover_region,p.request_streaming_region,p.request_original_language,
      (e.subscription_id IS NOT NULL AND e.blocked=FALSE) AS entitlement_active,
      rus.external_user_id,rus.external_email,rus.external_username,
      rus.status,rus.password_reset_required,rus.last_error,
      rus.last_attempt_at,rus.last_success_at,rus.active_permissions,
      rus.access_suspended,rus.applied_plan_id,
      rus.applied_movie_quota_limit,rus.applied_movie_quota_days,
      rus.applied_tv_quota_limit,rus.applied_tv_quota_days
    FROM customers c
    LEFT JOIN app_users u ON u.id=c.user_id
    LEFT JOIN effective_customer_entitlements e ON e.customer_id=c.id
    LEFT JOIN plans p ON p.id=e.plan_id
    LEFT JOIN LATERAL (
      SELECT (ARRAY_AGG(ja.jellyfin_username ORDER BY ja.is_primary DESC,ja.created_at))[1] AS jellyfin_username,
        COUNT(DISTINCT ja.server_id)::int AS active_server_count,
        STRING_AGG(DISTINCT js.name,', ' ORDER BY js.name) AS active_servers
      FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id
      WHERE ja.customer_id=c.id AND ja.disabled=FALSE AND js.enabled=TRUE
    ) jf ON TRUE
    LEFT JOIN request_user_sync rus ON rus.customer_id=c.id
    LEFT JOIN customer_request_permission_overrides cpo ON cpo.customer_id=c.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${boundedMode ? 'c.id' : "COALESCE(NULLIF(u.username,''),NULLIF(c.display_name,''),jf.jellyfin_username,'user')"}
    ${limitSql}
  `, params);
  return result.rows;
}

async function externalUsers() {
  const users = [], take = 100;
  for (let skip = 0; skip < 100000; skip += take) {
    const page = await apiRequest(`/api/v1/user?take=${take}&skip=${skip}&sort=displayname`), rows = Array.isArray(page?.results) ? page.results : [];
    users.push(...rows);
    if (rows.length < take) break;
  }
  return users;
}
async function externalUsersForCandidates(candidates) {
  const rows = Array.from(candidates || []);
  const wantedIds = new Set(rows.map(row => row.external_user_id == null ? null : String(row.external_user_id)).filter(Boolean));
  const wantedEmails = new Set();
  for (const candidate of rows) {
    for (const value of [requestLogin(candidate), ...legacyRequestEmails(candidate)]) {
      const identity = externalIdentity(value);
      if (identity) wantedEmails.add(identity);
    }
  }
  const indexes = { byId: new Map(), byEmail: new Map() };
  const take = 100;
  for (let skip = 0; skip < 100000; skip += take) {
    const page = await apiRequest(`/api/v1/user?take=${take}&skip=${skip}&sort=displayname`);
    const remoteRows = Array.isArray(page?.results) ? page.results : [];
    for (const user of remoteRows) {
      const id = user?.id == null ? null : String(user.id);
      const email = externalIdentity(user?.email);
      if ((id && wantedIds.has(id)) || (email && wantedEmails.has(email))) rememberExternal(indexes, user);
    }
    if (remoteRows.length < take) break;
  }
  return indexes;
}
async function permissionState(externalUserId) {
  const response = await apiRequest(`/api/v1/user/${encodeURIComponent(externalUserId)}/settings/permissions`), permissions = Number(response?.permissions);
  return Number.isInteger(permissions) && permissions >= 0 ? permissions : 0;
}
async function setPermissions(externalUserId, permissions) {
  await apiRequest(`/api/v1/user/${encodeURIComponent(externalUserId)}/settings/permissions`, { method: 'POST', body: { permissions: Math.max(0, Number(permissions) || 0) } });
}
function planValue(override, current, fallback = null) { return override === null || override === undefined || override === '' ? (current ?? fallback) : override; }
function requestLocale(override, current) {
  const value = planValue(override, current, 'en');
  return String(value || '').trim() || 'en';
}
function desiredMainSettings(current, externalUsername, plan, externalEmail = null) {
  const username = cleanUsername(plan?.username || externalUsername || current?.username);
  const email = externalIdentity(externalEmail || username);
  const discoverRegion = planValue(plan?.request_discover_region, current?.discoverRegion ?? current?.region, null);
  const streamingRegion = planValue(plan?.request_streaming_region, current?.streamingRegion ?? current?.region, null);
  return {
    username,
    email,
    locale: requestLocale(plan?.request_locale, current?.locale),
    discoverRegion,
    streamingRegion,
    region: discoverRegion,
    originalLanguage: planValue(plan?.request_original_language, current?.originalLanguage, null),
    watchlistSyncMovies: planValue(plan?.request_watchlist_sync_movies, current?.watchlistSyncMovies, false),
    watchlistSyncTv: planValue(plan?.request_watchlist_sync_tv, current?.watchlistSyncTv, false),
    movieQuotaLimit: quotaLimit(plan?.request_movie_quota_limit),
    movieQuotaDays: quotaDays(plan?.request_movie_quota_days),
    tvQuotaLimit: quotaLimit(plan?.request_tv_quota_limit),
    tvQuotaDays: quotaDays(plan?.request_tv_quota_days)
  };
}
function settingValue(value) { return value === undefined || value === null ? null : value; }
function mainSettingsChanged(current, desired) {
  return MANAGED_MAIN_FIELDS.some(field => settingValue(current?.[field]) !== settingValue(desired?.[field]));
}
async function syncMainSettings(externalUserId, externalUsername, plan, externalEmail = null) {
  const current = await apiRequest(`/api/v1/user/${encodeURIComponent(externalUserId)}/settings/main`);
  const settings = desiredMainSettings(current, externalUsername, plan, externalEmail);
  const changed = mainSettingsChanged(current, settings);
  if (changed) await apiRequest(`/api/v1/user/${encodeURIComponent(externalUserId)}/settings/main`, { method: 'POST', body: settings });
  return { settings, changed };
}
async function setQuotas(externalUserId, externalUsername, plan, externalEmail = null) {
  return (await syncMainSettings(externalUserId, externalUsername, plan, externalEmail)).settings;
}

async function mark(customerId, fields = {}) {
  const status = fields.status || 'pending';
  await query(`
    INSERT INTO request_user_sync(customer_id,external_user_id,external_email,external_username,status,password_reset_required,last_error,last_attempt_at,last_success_at,updated_at,active_permissions,access_suspended,applied_plan_id,applied_movie_quota_limit,applied_movie_quota_days,applied_tv_quota_limit,applied_tv_quota_days)
    VALUES($1,$2,$3,$4,$5,$6,$7,NOW(),CASE WHEN $5='synced' THEN NOW() ELSE NULL END,NOW(),$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT(customer_id) DO UPDATE SET external_user_id=COALESCE(EXCLUDED.external_user_id,request_user_sync.external_user_id),external_email=COALESCE(EXCLUDED.external_email,request_user_sync.external_email),external_username=COALESCE(EXCLUDED.external_username,request_user_sync.external_username),status=EXCLUDED.status,password_reset_required=EXCLUDED.password_reset_required,last_error=EXCLUDED.last_error,last_attempt_at=NOW(),last_success_at=CASE WHEN EXCLUDED.status='synced' THEN NOW() ELSE request_user_sync.last_success_at END,active_permissions=COALESCE(EXCLUDED.active_permissions,request_user_sync.active_permissions),access_suspended=EXCLUDED.access_suspended,applied_plan_id=EXCLUDED.applied_plan_id,applied_movie_quota_limit=EXCLUDED.applied_movie_quota_limit,applied_movie_quota_days=EXCLUDED.applied_movie_quota_days,applied_tv_quota_limit=EXCLUDED.applied_tv_quota_limit,applied_tv_quota_days=EXCLUDED.applied_tv_quota_days,updated_at=NOW()
  `, [customerId, fields.externalUserId || null, fields.email || null, fields.username || null, status, Boolean(fields.passwordResetRequired), fields.error ? String(fields.error).slice(0, 1000) : null, fields.activePermissions == null ? null : Math.max(0, Number(fields.activePermissions) || 0), Boolean(fields.accessSuspended), fields.planId || null, fields.movieQuotaLimit == null ? null : Number(fields.movieQuotaLimit), fields.movieQuotaDays == null ? null : Number(fields.movieQuotaDays), fields.tvQuotaLimit == null ? null : Number(fields.tvQuotaLimit), fields.tvQuotaDays == null ? null : Number(fields.tvQuotaDays)]);
}
async function clearExternalBinding(customerId) {
  await query(`
    UPDATE request_user_sync
    SET external_user_id=NULL,status='synced',password_reset_required=FALSE,last_error=NULL,
      last_attempt_at=NOW(),last_success_at=NOW(),access_suspended=TRUE,applied_plan_id=NULL,updated_at=NOW()
    WHERE customer_id=$1
  `, [customerId]);
}
function desiredPermissions(candidate, currentPermissions) {
  if (candidate.request_permission_override !== null && candidate.request_permission_override !== undefined) {
    return planPolicy.sanitizePermissionMask(candidate.request_permission_override) ?? REQUEST_PERMISSION;
  }
  const remembered = Number(candidate.active_permissions);
  const fallback = Number.isInteger(remembered) && remembered > 0 ? remembered : currentPermissions > 0 ? currentPermissions : REQUEST_PERMISSION;
  return planPolicy.planPermissionMask(candidate, fallback) ?? REQUEST_PERMISSION;
}
function indexesFor(users) {
  return { byId: new Map(users.filter(user => user?.id != null).map(user => [String(user.id), user])), byEmail: new Map(users.filter(user => user?.email).map(user => [externalIdentity(user.email), user])) };
}
function rememberExternal(indexes, external, previousEmail = null) {
  const id = external?.id == null ? null : String(external.id);
  const nextEmail = externalIdentity(external?.email);
  const oldEmail = externalIdentity(previousEmail);
  if (oldEmail && oldEmail !== nextEmail && indexes?.byEmail) {
    const previous = indexes.byEmail.get(oldEmail);
    if (!id || (previous?.id != null && String(previous.id) === id)) indexes.byEmail.delete(oldEmail);
  }
  if (id && indexes?.byId) indexes.byId.set(id, external);
  if (nextEmail && indexes?.byEmail) indexes.byEmail.set(nextEmail, external);
  return external;
}
function forgetExternal(indexes, external) {
  const id = external?.id == null ? null : String(external.id);
  const email = externalIdentity(external?.email);
  if (id && indexes?.byId) indexes.byId.delete(id);
  if (email && indexes?.byEmail) {
    const current = indexes.byEmail.get(email);
    if (!id || (current?.id != null && String(current.id) === id)) indexes.byEmail.delete(email);
  }
}
function protectedExternalUser(external, linkedId, livePermissions = external?.permissions) {
  const id = String(linkedId || '');
  const apiUserId = requestApiUserId();
  if (id === '1' || (apiUserId && id === apiUserId)) return true;
  return (Number(livePermissions || 0) & SEERR_PROTECTED_DELETE_MASK) !== 0;
}
function deletionIdentityMatches(candidate, external) {
  const expected = new Set([candidate?.external_email, candidate?.external_username].map(externalIdentity).filter(Boolean));
  if (!expected.size) return false;
  return [external?.email, external?.username, external?.jellyfinUsername].map(externalIdentity).some(value => value && expected.has(value));
}
async function assertExclusiveExternalOwnership(customerId, linkedId) {
  const other = await query(`SELECT customer_id FROM request_user_sync WHERE external_user_id=$1 AND customer_id<>$2 LIMIT 1`, [linkedId, customerId]);
  if (other.rowCount) throw new Error(`Refusing to manage Seerr account #${linkedId}: it is also linked to another Fin-Fusion customer.`);
}
async function finalizeRemovedBinding(candidate, external, linkedId, activePermissions, deleted) {
  const metadata = {
    externalUserId: String(linkedId),
    externalEmail: external?.email || candidate.external_email || null,
    externalUsername: external?.username || candidate.external_username || null,
    reason: 'request_entitlement_inactive',
    remoteDeleted: Boolean(deleted)
  };
  await transaction(async client => {
    const cleared = await client.query(`
      UPDATE request_user_sync
      SET external_user_id=NULL,status='synced',password_reset_required=FALSE,last_error=NULL,
        last_attempt_at=NOW(),last_success_at=NOW(),active_permissions=COALESCE($3,active_permissions),
        access_suspended=TRUE,applied_plan_id=NULL,updated_at=NOW()
      WHERE customer_id=$1 AND external_user_id=$2
      RETURNING customer_id
    `, [candidate.customer_id, linkedId, activePermissions]);
    if (!cleared.rowCount) throw new Error(`Request-user binding changed while deleting Seerr account #${linkedId}; refusing to record an ambiguous cleanup.`);
    if (deleted) {
      await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES(NULL,'automation.request_user.delete','customer',$1,$2::jsonb)`, [String(candidate.customer_id), JSON.stringify(metadata)]);
    }
  });
}
async function removeCustomer(candidate, indexes = {}, options = {}) {
  const linkedId = candidate?.external_user_id == null ? '' : String(candidate.external_user_id);
  if (!linkedId) {
    await mark(candidate.customer_id, { status: 'skipped', email: candidate.external_email || validEmail(candidate.email), username: candidate.external_username || cleanUsername(candidate.username), passwordResetRequired: false, activePermissions: candidate.active_permissions, accessSuspended: true, planId: null, movieQuotaLimit: candidate.applied_movie_quota_limit, movieQuotaDays: candidate.applied_movie_quota_days, tvQuotaLimit: candidate.applied_tv_quota_limit, tvQuotaDays: candidate.applied_tv_quota_days });
    return { status: 'ignored', customerId: candidate.customer_id, remoteChanged: false };
  }
  let external = null;
  return withExternalSyncLock(options._lockClient, linkedId, async () => {
    try {
      try {
        external = await apiRequest(`/api/v1/user/${encodeURIComponent(linkedId)}`);
      } catch (error) {
        if (Number(error?.statusCode) === 404) {
          await clearExternalBinding(candidate.customer_id);
          return { status: 'suspended', customerId: candidate.customer_id, remoteChanged: false };
        }
        throw error;
      }
      await assertExclusiveExternalOwnership(candidate.customer_id, linkedId);
      if (!deletionIdentityMatches(candidate, external)) {
        throw new Error(`Refusing to delete Seerr account #${linkedId}: the live remote identity no longer matches Fin-Fusion's stored binding.`);
      }
      const currentPermissions = await permissionState(linkedId);
      if (protectedExternalUser(external, linkedId, currentPermissions)) {
        throw new Error(`Refusing to delete protected Seerr administrator/user-manager account #${linkedId}.`);
      }
      const finalEntitlement = await requestEntitlements.resolve(candidate.customer_id);
      if (finalEntitlement?.entitlement_active && finalEntitlement.request_access_enabled !== false) {
        return syncCustomerLocked({ ...candidate, ...finalEntitlement }, indexes, options);
      }
      const activePermissions = desiredPermissions(candidate, currentPermissions);
      let deleted = true;
      try {
        await apiRequest(`/api/v1/user/${encodeURIComponent(linkedId)}`, { method: 'DELETE' });
      } catch (error) {
        if (Number(error?.statusCode) === 404) deleted = false;
        else throw error;
      }
      await finalizeRemovedBinding(candidate, external, linkedId, activePermissions, deleted);
      forgetExternal(indexes, external);
      return { status: 'suspended', customerId: candidate.customer_id, remoteChanged: deleted };
    } catch (error) {
      await mark(candidate.customer_id, { status: 'failed', externalUserId: linkedId, email: external?.email || candidate.external_email, username: external?.username || candidate.external_username || candidate.username, passwordResetRequired: Boolean(candidate.password_reset_required), activePermissions: candidate.active_permissions, accessSuspended: Boolean(candidate.access_suspended), planId: candidate.applied_plan_id, movieQuotaLimit: candidate.applied_movie_quota_limit, movieQuotaDays: candidate.applied_movie_quota_days, tvQuotaLimit: candidate.applied_tv_quota_limit, tvQuotaDays: candidate.applied_tv_quota_days, error: error.message });
      return { status: 'failed', customerId: candidate.customer_id, error: error.message, remoteChanged: false };
    }
  });
}
async function createExternalUserConvergently({ candidate, indexes, email, username, password, createUser = null, listUsers = null }) {
  const create = createUser || (body => apiRequest('/api/v1/user', { method: 'POST', body }));
  const refresh = listUsers || (async () => {
    const targeted = await externalUsersForCandidates([candidate]);
    return [...new Map([...targeted.byId.values(), ...targeted.byEmail.values()].map(user => [String(user.id), user])).values()];
  });
  try {
    const external = await create({ email, username, password });
    return { external: rememberExternal(indexes, external), created: true, recoveredConcurrentCreate: false };
  } catch (createError) {
    let refreshed;
    try { refreshed = indexesFor(await refresh()); }
    catch { throw createError; }
    let external = trustedExternalForCandidate(candidate, refreshed);
    if (!external) {
      const target = refreshed.byEmail.get(externalIdentity(email)) || null;
      if (target && externalIdentity(target.username) === externalIdentity(username)) external = target;
    }
    if (!external) throw createError;
    return { external: rememberExternal(indexes, external), created: false, recoveredConcurrentCreate: true };
  }
}
async function resolveRequestCandidate(candidate) {
  if (candidate?.entitlement_active && candidate.request_access_enabled !== false) return candidate;
  const alternate = candidate?.customer_id ? await requestEntitlements.resolve(candidate.customer_id) : null;
  return alternate?.entitlement_active ? { ...candidate, ...alternate } : candidate;
}
async function syncCustomerLocked(candidate, indexes = {}, options = {}) {
  candidate = await resolveRequestCandidate(candidate);
  const username = cleanUsername(candidate?.username), email = requestLogin(candidate);
  const suppliedPassword = typeof options.password === 'string' && options.password.length >= 12 && options.password.length <= 200 ? options.password : null;
  let external = trustedExternalForCandidate(candidate, indexes), bindingSafe = Boolean(candidate.external_user_id);
  if (!candidate.entitlement_active || candidate.request_access_enabled === false) return removeCustomer(candidate, indexes, options);
  try {
    const collision = loginCollisionForCandidate(candidate, indexes, email, external);
    if (collision) throw new Error(`Request-site login "${email}" is already used by another Seerr account; refusing to adopt or overwrite it.`);
    let created = false, recoveredConcurrentCreate = false;
    if (!external) {
      const bootstrapPassword = suppliedPassword || crypto.randomBytes(30).toString('base64url');
      const creation = await createExternalUserConvergently({ candidate, indexes, email, username, password: bootstrapPassword });
      external = creation.external;
      created = creation.created;
      recoveredConcurrentCreate = creation.recoveredConcurrentCreate;
    }
    if (!external?.id) throw new Error('Request service did not return a user id.');
    return await withExternalSyncLock(options._lockClient, external.id, async () => {
      await assertExclusiveExternalOwnership(candidate.customer_id, external.id);
      bindingSafe = true;
      rememberExternal(indexes, external);
      const currentPermissions = await permissionState(external.id);
      if (protectedExternalUser(external, external.id, currentPermissions)) throw new Error(`Refusing to manage protected Seerr administrator/user-manager account #${external.id}.`);
      const activePermissions = desiredPermissions(candidate, currentPermissions);
      const permissionsChanged = currentPermissions !== activePermissions;
      if (permissionsChanged) await setPermissions(external.id, activePermissions);
      const previousEmail = external.email;
      const main = await syncMainSettings(external.id, username, candidate, email);
      const settings = main.settings;
      if (main.changed) {
        external.email = settings.email;
        external.username = settings.username;
        rememberExternal(indexes, external, previousEmail);
      }
      const passwordResetRequired = Boolean(candidate.password_reset_required) || (created && !suppliedPassword) || recoveredConcurrentCreate;
      await mark(candidate.customer_id, { status: 'synced', externalUserId: external.id, email: settings.email, username: settings.username, passwordResetRequired, activePermissions, accessSuspended: false, planId: candidate.plan_id, movieQuotaLimit: settings.movieQuotaLimit, movieQuotaDays: settings.movieQuotaDays, tvQuotaLimit: settings.tvQuotaLimit, tvQuotaDays: settings.tvQuotaDays });
      return { status: 'synced', customerId: candidate.customer_id, created, recoveredConcurrentCreate, passwordApplied: Boolean(created && suppliedPassword), remoteChanged: created || permissionsChanged || main.changed };
    });
  } catch (error) {
    await mark(candidate.customer_id, { status: 'failed', externalUserId: bindingSafe ? (external?.id || candidate.external_user_id) : candidate.external_user_id, email: external?.email || email, username: external?.username || username, passwordResetRequired: Boolean(candidate.password_reset_required), activePermissions: candidate.active_permissions, accessSuspended: Boolean(candidate.access_suspended), planId: candidate.applied_plan_id, movieQuotaLimit: candidate.applied_movie_quota_limit, movieQuotaDays: candidate.applied_movie_quota_days, tvQuotaLimit: candidate.applied_tv_quota_limit, tvQuotaDays: candidate.applied_tv_quota_days, error: error.message });
    return { status: 'failed', customerId: candidate.customer_id, error: error.message, remoteChanged: false };
  }
}
async function syncCustomer(candidate, indexes = {}, options = {}) {
  const customerId = String(candidate?.customer_id || '').trim();
  if (!customerId) return syncCustomerLocked(candidate, indexes, options);
  return withCustomerSyncLock(customerId, lockClient => syncCustomerLocked(candidate, indexes, { ...options, _lockClient: lockClient }));
}
function cleanFailureMessage(value) {
  const message = String(value || 'Request-user sync failed').replace(/\s+/g, ' ').trim();
  return (message || 'Request-user sync failed').slice(0, 300);
}
function emptySummary(total) {
  return { total, created: 0, linked: 0, suspended: 0, failed: 0, _failureReasons: new Map() };
}
function countResult(summary, result) {
  if (result.status === 'failed') {
    summary.failed++;
    const message = cleanFailureMessage(result.error);
    summary._failureReasons.set(message, Number(summary._failureReasons.get(message) || 0) + 1);
  } else if (result.status === 'suspended') summary.suspended++;
  else if (result.status === 'ignored') summary.ignored = Number(summary.ignored || 0) + 1;
  else if (result.created) summary.created++;
  else if (result.status === 'synced') summary.linked++;
  if (summary._operational) {
    summary._operational.usersInspected++;
    if (result.status === 'failed') summary._operational.failed++;
    else if (result.remoteChanged) summary._operational.updated++;
    else summary._operational.unchanged++;
  }
}
function finalizeSummary(summary) {
  const reasons = [...(summary._failureReasons || new Map()).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  delete summary._failureReasons;
  if (summary._operational) {
    summary.metrics = { ...summary._operational, elapsedMs: Math.max(0, Date.now() - summary._operational.startedAt) };
    delete summary.metrics.startedAt;
    delete summary._operational;
  }
  if (summary.failed > 0 && reasons.length) {
    const [message, count] = reasons[0];
    const otherCount = reasons.slice(1).reduce((total, [, occurrences]) => total + occurrences, 0);
    summary.warning = `${summary.failed} request-user sync${summary.failed === 1 ? '' : 's'} failed. Most common: ${count}× ${message}${otherCount ? ` · ${otherCount} other failure${otherCount === 1 ? '' : 's'}` : ''}`.slice(0, 1200);
  }
  return summary;
}
function operationalSummary(total) {
  const summary = emptySummary(total);
  summary._operational = { usersInspected: 0, unchanged: 0, updated: 0, failed: 0, concurrency: syncConcurrency(), startedAt: Date.now() };
  return summary;
}
async function syncBatch(candidates, indexes, summary) {
  const results = await mapBounded(candidates, summary._operational?.concurrency || syncConcurrency(), async candidate => {
    try { return await syncCustomer(candidate, indexes); }
    catch (error) { return { status: 'failed', customerId: candidate.customer_id, error: error.message, remoteChanged: false }; }
  });
  for (const result of results) countResult(summary, result);
}
async function requestRoleRetry() {
  const result = await query(`
    UPDATE automation_job_state
    SET next_run_at=NOW(),force_run_requested=TRUE,updated_at=NOW()
    WHERE job_key='request_users' AND enabled=TRUE
    RETURNING job_key
  `);
  return result.rows[0] || null;
}
async function syncAll() {
  const config = await configuration();
  if (!config.configured) throw new Error('Configure the external request service URL and API key first.');
  const pageSize = syncBatchSize();
  let after = await scanCursor.load(REQUEST_SCAN_KEY);
  if (after && !isUuid(after)) {
    await scanCursor.clear(REQUEST_SCAN_KEY);
    after = null;
  }
  const fetched = await syncCandidates({ after, limit: pageSize + 1 });
  const hasMore = fetched.length > pageSize;
  const candidates = hasMore ? fetched.slice(0, pageSize) : fetched;
  const indexes = await externalUsersForCandidates(candidates);
  const summary = operationalSummary(candidates.length);
  await syncBatch(candidates, indexes, summary);
  const finalized = finalizeSummary(summary);
  if (candidates.length && hasMore) {
    const cursor = String(candidates[candidates.length - 1].customer_id || '');
    if (!isUuid(cursor)) throw new Error('Request-user sync produced an invalid durable cursor.');
    await scanCursor.save(REQUEST_SCAN_KEY, cursor);
    finalized.cursor = cursor;
  } else {
    await scanCursor.clear(REQUEST_SCAN_KEY);
    finalized.cursor = null;
  }
  finalized.hasMore = hasMore;
  if (hasMore && finalized.failed === 0) await requestRoleRetry();
  return finalized;
}
function selectedIds(values) {
  const ids = [...new Set((Array.isArray(values) ? values : [values]).map(v => String(v || '').trim()).filter(isUuid))];
  if (!ids.length) throw new Error('Select at least one managed request user.');
  if (ids.length > 500) throw new Error('Select no more than 500 request users at once.');
  return ids;
}
async function syncSelected(customerIds) {
  const ids = selectedIds(customerIds), config = await configuration();
  if (!config.configured) throw new Error('Configure the external request service URL and API key first.');
  const candidates = await syncCandidates({ ids, limit: ids.length });
  if (candidates.length !== ids.length) throw new Error('One or more selected customers no longer exist. Refresh the page and try again.');
  const indexes = await externalUsersForCandidates(candidates), summary = operationalSummary(candidates.length);
  await syncBatch(candidates, indexes, summary);
  return finalizeSummary(summary);
}
async function syncOneCustomer(customerId, options = {}) {
  const ids = selectedIds([customerId]);
  const candidates = await syncCandidates({ ids, limit: 1 }), candidate = candidates[0];
  if (!candidate) throw new Error('Customer not found.');
  const indexes = await externalUsersForCandidates([candidate]);
  return syncCustomer(candidate, indexes, options);
}
async function requestAccessForCustomer(customerId) {
  const result = await query(`
    SELECT rus.*,COALESCE(NULLIF(u.email,''),NULLIF(c.email,'')) AS customer_email,
      p.name AS applied_plan_name,p.code AS applied_plan_code
    FROM customers c
    LEFT JOIN app_users u ON u.id=c.user_id
    LEFT JOIN request_user_sync rus ON rus.customer_id=c.id
    LEFT JOIN plans p ON p.id=rus.applied_plan_id
    WHERE c.id=$1
  `,[customerId]);
  const state = result.rows[0] || null;
  if (!state) return null;
  const entitlement = await requestEntitlements.resolve(customerId);
  return { ...state, ...(entitlement || {}), entitlement_active: Boolean(entitlement?.entitlement_active), request_access_enabled: Boolean(entitlement?.request_access_enabled) };
}
async function setCustomerPassword(customerId, password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw new Error('Request-site password must be between 8 and 200 characters.');
  let access = await requestAccessForCustomer(customerId);
  if (!access?.entitlement_active) throw new Error('Request access requires an active plan or trial with request access enabled.');
  if (!access?.external_user_id) {
    const result = await syncOneCustomer(customerId, { password });
    if (result.status !== 'synced') throw new Error(result.error || 'Request-site user could not be synced.');
    access = await requestAccessForCustomer(customerId);
  }
  if (!access?.external_user_id) throw new Error('Request-site user is not synced yet.');
  if (access.access_suspended) throw new Error('Request access is suspended until an active plan or trial with request access is available again.');
  await apiRequest(`/api/v1/user/${encodeURIComponent(access.external_user_id)}/settings/password`, { method: 'POST', body: { newPassword: password } });
  await query(`UPDATE request_user_sync SET password_reset_required=FALSE,last_error=NULL,updated_at=NOW() WHERE customer_id=$1`, [customerId]);
  return true;
}
async function markPasswordSyncFailure(customerId, error) {
  await query(`UPDATE request_user_sync SET password_reset_required=TRUE,last_error=$2,updated_at=NOW() WHERE customer_id=$1`, [customerId, String(error?.message || error || 'Request password sync failed').slice(0, 1000)]);
}
async function statusSummary() {
  const [config, counts, suspended] = await Promise.all([configuration(), query(`SELECT status,COUNT(*)::int AS count FROM request_user_sync GROUP BY status`), query(`SELECT COUNT(*)::int AS count FROM request_user_sync WHERE access_suspended=TRUE`)]);
  return { ...config, counts: Object.fromEntries(counts.rows.map(row => [row.status, row.count])), suspended: Number(suspended.rows[0]?.count || 0) };
}

module.exports = { REQUEST_PERMISSION, DEFAULT_SYNC_CONCURRENCY, DEFAULT_SYNC_BATCH_SIZE, MAX_SYNC_BATCH_SIZE, REQUEST_SCAN_KEY, cleanBaseUrl, requestApiUserId, requestHeaders, configuration, apiRequest, validEmail, cleanUsername, fallbackEmail, quotaLimit, quotaDays, syncConcurrency, syncBatchSize, isUuid, mapBounded, withSessionAdvisoryLock, withCustomerSyncLock, withExternalSyncLock, syncCandidates, externalUsers, externalUsersForCandidates, permissionState, setPermissions, desiredMainSettings, mainSettingsChanged, syncMainSettings, setQuotas, cleanFailureMessage, emptySummary, countResult, finalizeSummary, syncAll, syncSelected, syncOneCustomer, requestAccessForCustomer, setCustomerPassword, markPasswordSyncFailure, statusSummary, resolveRequestCandidate, indexesFor, rememberExternal, forgetExternal, clearExternalBinding, intentionallyRemoved, protectedExternalUser, deletionIdentityMatches, assertExclusiveExternalOwnership, finalizeRemovedBinding, removeCustomer, createExternalUserConvergently, syncCustomerLocked, syncCustomer, syncBatch, requestRoleRetry };
