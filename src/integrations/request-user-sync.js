'use strict';

const crypto = require('crypto');
const { query } = require('../db');
const requestSettings = require('./request-service-settings');
const planPolicy = require('./request-plan-policy');
const requestEntitlements = require('./request-entitlement');
const outbound = require('../security/outbound-url-policy');

const REQUEST_PERMISSION = planPolicy.DEFAULT_REQUEST_MASK;
const DEFAULT_SYNC_CONCURRENCY = 3;
const MAX_SYNC_CONCURRENCY = 8;
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
    const response = await outbound.safeFetch(url, { purpose: 'Request service', method, timeoutMs, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Api-Key': config.apiKey }, body: body == null ? undefined : JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.message || `Request service returned HTTP ${response.status}`);
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
function fallbackEmail(customerId) {
  const compact = String(customerId || '').replace(/[^a-f0-9]/gi, '').toLowerCase().slice(0, 24) || crypto.randomBytes(8).toString('hex');
  return `cf-${compact}@captainfin.invalid`;
}
function quotaLimit(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : 0; }
function quotaDays(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : 30; }
function syncConcurrency(value = process.env.REQUEST_USER_SYNC_CONCURRENCY) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(MAX_SYNC_CONCURRENCY, parsed) : DEFAULT_SYNC_CONCURRENCY;
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

async function syncCandidates() {
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
    ORDER BY COALESCE(NULLIF(u.username,''),NULLIF(c.display_name,''),jf.jellyfin_username,'user')
  `);
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
  const email = validEmail(current?.email) || validEmail(externalEmail) || fallbackEmail(plan?.customer_id);
  const discoverRegion = planValue(plan?.request_discover_region, current?.discoverRegion ?? current?.region, null);
  const streamingRegion = planValue(plan?.request_streaming_region, current?.streamingRegion ?? current?.region, null);
  return {
    username: current?.username ?? externalUsername ?? cleanUsername(plan?.username),
    email,
    locale: requestLocale(plan?.request_locale, current?.locale),
    discoverRegion,
    streamingRegion,
    // Kept for compatibility with older Overseerr/Jellyseerr releases that
    // represented both region settings as one field. Modern Seerr ignores it.
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
function desiredPermissions(candidate, currentPermissions) {
  if (candidate.request_permission_override !== null && candidate.request_permission_override !== undefined) {
    return planPolicy.sanitizePermissionMask(candidate.request_permission_override) ?? REQUEST_PERMISSION;
  }
  const remembered = Number(candidate.active_permissions);
  const fallback = Number.isInteger(remembered) && remembered > 0 ? remembered : currentPermissions > 0 ? currentPermissions : REQUEST_PERMISSION;
  return planPolicy.planPermissionMask(candidate, fallback) ?? REQUEST_PERMISSION;
}
async function suspendCustomer(candidate, external, { planId = null, desired = null } = {}) {
  if (!external?.id) {
    await mark(candidate.customer_id, { status: 'skipped', email: candidate.external_email || validEmail(candidate.email), username: candidate.external_username || cleanUsername(candidate.username), passwordResetRequired: Boolean(candidate.password_reset_required), activePermissions: desired ?? candidate.active_permissions, accessSuspended: true, planId, movieQuotaLimit: candidate.applied_movie_quota_limit, movieQuotaDays: candidate.applied_movie_quota_days, tvQuotaLimit: candidate.applied_tv_quota_limit, tvQuotaDays: candidate.applied_tv_quota_days });
    return { status: 'ignored', customerId: candidate.customer_id, remoteChanged: false };
  }
  try {
    const currentPermissions = await permissionState(external.id);
    const activePermissions = desired == null ? desiredPermissions(candidate, currentPermissions) : planPolicy.sanitizePermissionMask(desired) ?? REQUEST_PERMISSION;
    const remoteChanged = currentPermissions !== 0;
    if (remoteChanged) await setPermissions(external.id, 0);
    await mark(candidate.customer_id, { status: 'synced', externalUserId: external.id, email: external.email || candidate.external_email || validEmail(candidate.email), username: external.username || candidate.external_username || candidate.username, passwordResetRequired: Boolean(candidate.password_reset_required), activePermissions, accessSuspended: true, planId, movieQuotaLimit: candidate.applied_movie_quota_limit, movieQuotaDays: candidate.applied_movie_quota_days, tvQuotaLimit: candidate.applied_tv_quota_limit, tvQuotaDays: candidate.applied_tv_quota_days });
    return { status: 'suspended', customerId: candidate.customer_id, remoteChanged };
  } catch (error) {
    await mark(candidate.customer_id, { status: 'failed', externalUserId: external.id, email: external.email || candidate.external_email, username: external.username || candidate.username, passwordResetRequired: Boolean(candidate.password_reset_required), activePermissions: candidate.active_permissions, accessSuspended: Boolean(candidate.access_suspended), planId: candidate.applied_plan_id, movieQuotaLimit: candidate.applied_movie_quota_limit, movieQuotaDays: candidate.applied_movie_quota_days, tvQuotaLimit: candidate.applied_tv_quota_limit, tvQuotaDays: candidate.applied_tv_quota_days, error: error.message });
    return { status: 'failed', customerId: candidate.customer_id, error: error.message, remoteChanged: false };
  }
}
function indexesFor(users) {
  return { byId: new Map(users.filter(user => user?.id != null).map(user => [String(user.id), user])), byEmail: new Map(users.filter(user => user?.email).map(user => [String(user.email).toLowerCase(), user])) };
}
async function resolveRequestCandidate(candidate) {
  if (candidate?.entitlement_active && candidate.request_access_enabled !== false) return candidate;
  const alternate = candidate?.customer_id ? await requestEntitlements.resolve(candidate.customer_id) : null;
  return alternate?.entitlement_active ? { ...candidate, ...alternate } : candidate;
}
async function syncCustomer(candidate, indexes = {}, options = {}) {
  candidate = await resolveRequestCandidate(candidate);
  const username = cleanUsername(candidate.username), email = validEmail(candidate.email) || candidate.external_email || fallbackEmail(candidate.customer_id);
  const suppliedPassword = typeof options.password === 'string' && options.password.length >= 12 && options.password.length <= 200 ? options.password : null;
  let external = candidate.external_user_id ? indexes.byId?.get(String(candidate.external_user_id)) : null;
  if (!external) external = indexes.byEmail?.get(String(email).toLowerCase()) || null;
  if (!candidate.entitlement_active) return suspendCustomer(candidate, external, { planId: null });
  if (candidate.request_access_enabled === false) {
    const managedDesired = candidate.request_permissions == null ? null : planPolicy.sanitizePermissionMask(candidate.request_permissions);
    return suspendCustomer(candidate, external, { planId: candidate.plan_id, desired: managedDesired });
  }
  try {
    let created = false;
    if (!external) {
      const bootstrapPassword = suppliedPassword || crypto.randomBytes(30).toString('base64url');
      external = await apiRequest('/api/v1/user', { method: 'POST', body: { email, username, password: bootstrapPassword } });
      created = true;
      if (external?.id && indexes.byId) indexes.byId.set(String(external.id), external);
      if (external?.email && indexes.byEmail) indexes.byEmail.set(String(external.email).toLowerCase(), external);
    }
    if (!external?.id) throw new Error('Request service did not return a user id.');
    const currentPermissions = await permissionState(external.id);
    const activePermissions = desiredPermissions(candidate, currentPermissions);
    const permissionsChanged = currentPermissions !== activePermissions;
    if (permissionsChanged) await setPermissions(external.id, activePermissions);
    const main = await syncMainSettings(external.id, external.username || username, candidate, external.email || email);
    const settings = main.settings;
    await mark(candidate.customer_id, { status: 'synced', externalUserId: external.id, email: external.email || email, username: external.username || username, passwordResetRequired: Boolean(candidate.password_reset_required) || (created && !suppliedPassword), activePermissions, accessSuspended: false, planId: candidate.plan_id, movieQuotaLimit: settings.movieQuotaLimit, movieQuotaDays: settings.movieQuotaDays, tvQuotaLimit: settings.tvQuotaLimit, tvQuotaDays: settings.tvQuotaDays });
    return { status: 'synced', customerId: candidate.customer_id, created, passwordApplied: Boolean(created && suppliedPassword), remoteChanged: created || permissionsChanged || main.changed };
  } catch (error) {
    await mark(candidate.customer_id, { status: 'failed', externalUserId: external?.id || candidate.external_user_id, email: external?.email || email, username: external?.username || username, passwordResetRequired: Boolean(candidate.password_reset_required), activePermissions: candidate.active_permissions, accessSuspended: Boolean(candidate.access_suspended), planId: candidate.applied_plan_id, movieQuotaLimit: candidate.applied_movie_quota_limit, movieQuotaDays: candidate.applied_movie_quota_days, tvQuotaLimit: candidate.applied_tv_quota_limit, tvQuotaDays: candidate.applied_tv_quota_days, error: error.message });
    return { status: 'failed', customerId: candidate.customer_id, error: error.message, remoteChanged: false };
  }
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
async function syncAll() {
  const config = await configuration();
  if (!config.configured) throw new Error('Configure the external request service URL and API key first.');
  const [candidates, existing] = await Promise.all([syncCandidates(), externalUsers()]), indexes = indexesFor(existing), summary = operationalSummary(candidates.length);
  await syncBatch(candidates, indexes, summary);
  return finalizeSummary(summary);
}
function selectedIds(values) {
  const ids = [...new Set((Array.isArray(values) ? values : [values]).map(v => String(v || '').trim()).filter(v => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)))];
  if (!ids.length) throw new Error('Select at least one managed request user.');
  if (ids.length > 500) throw new Error('Select no more than 500 request users at once.');
  return ids;
}
async function syncSelected(customerIds) {
  const ids = selectedIds(customerIds), config = await configuration();
  if (!config.configured) throw new Error('Configure the external request service URL and API key first.');
  const [allCandidates, existing] = await Promise.all([syncCandidates(), externalUsers()]);
  const wanted = new Set(ids), candidates = allCandidates.filter(row => wanted.has(String(row.customer_id)));
  if (candidates.length !== ids.length) throw new Error('One or more selected customers no longer exist. Refresh the page and try again.');
  const indexes = indexesFor(existing), summary = operationalSummary(candidates.length);
  await syncBatch(candidates, indexes, summary);
  return finalizeSummary(summary);
}
async function syncOneCustomer(customerId, options = {}) {
  const candidates = await syncCandidates(), candidate = candidates.find(row => String(row.customer_id) === String(customerId));
  if (!candidate) throw new Error('Customer not found.');
  const existing = await externalUsers();
  return syncCustomer(candidate, indexesFor(existing), options);
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

module.exports = { REQUEST_PERMISSION, DEFAULT_SYNC_CONCURRENCY, cleanBaseUrl, configuration, apiRequest, validEmail, cleanUsername, fallbackEmail, quotaLimit, quotaDays, syncConcurrency, mapBounded, syncCandidates, externalUsers, permissionState, setPermissions, desiredMainSettings, mainSettingsChanged, syncMainSettings, setQuotas, cleanFailureMessage, emptySummary, countResult, finalizeSummary, syncAll, syncSelected, syncOneCustomer, requestAccessForCustomer, setCustomerPassword, markPasswordSyncFailure, statusSummary, resolveRequestCandidate };
