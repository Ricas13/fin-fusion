'use strict';

const TYPES = Object.freeze(['jellyfin', 'emby']);

function normalizeType(value) {
  const type = String(value || 'jellyfin').trim().toLowerCase();
  if (!TYPES.includes(type)) throw new Error(`Unsupported media server type: ${type}`);
  return type;
}

function label(value) {
  return normalizeType(value) === 'emby' ? 'Emby' : 'Jellyfin';
}

function authHeaders(type, apiKey, { jsonBody = false } = {}) {
  const provider = normalizeType(type);
  const token = String(apiKey || '').trim();
  if (!token) throw new Error(`${label(provider)} API key is required.`);
  if (/[\r\n]/.test(token)) throw new Error(`${label(provider)} API key contains invalid characters.`);
  const auth = provider === 'emby'
    ? { 'X-Emby-Token': token }
    : { Authorization: `MediaBrowser Token="${token}"` };
  return { ...auth, Accept:'application/json', ...(jsonBody ? { 'Content-Type':'application/json' } : {}) };
}

function apiPath(type, endpoint) {
  const provider = normalizeType(type);
  const path = String(endpoint || '');
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid media server API endpoint.');
  if (provider !== 'emby') return path;
  if (path === '/emby' || path.startsWith('/emby/')) return path;
  return `/emby${path}`;
}

function healthEndpoint(type) {
  return normalizeType(type) === 'emby' ? '/System/Info' : '/System/Info/Public';
}

function userPolicyOverrides(type) {
  if (normalizeType(type) !== 'emby') return null;
  // Emby and Jellyfin share the MediaBrowser user-policy shape, but Jellyfin's
  // concrete authentication provider IDs are not portable to Emby. Keeping
  // these overrides provider-owned avoids sprinkling implementation checks
  // through the entitlement/provisioning layer.
  return {
    AuthenticationProviderId: undefined,
    PasswordResetProviderId: undefined
  };
}

module.exports = { TYPES, normalizeType, label, authHeaders, apiPath, healthEndpoint, userPolicyOverrides };
