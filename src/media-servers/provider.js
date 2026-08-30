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

function canonicalPath(endpoint) {
  const value=String(endpoint||'');
  const parsed=new URL(value,'http://media.invalid');
  return parsed.pathname.replace(/^\/emby(?=\/|$)/, '') || '/';
}

function apiPath(type, endpoint) {
  const provider = normalizeType(type);
  const path = String(endpoint || '');
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid media server API endpoint.');
  if (provider !== 'emby') return path;
  const parsed=new URL(path,'http://media.invalid');
  const canonical=parsed.pathname.replace(/^\/emby(?=\/|$)/,'')||'/';
  // Jellyfin supports activeWithinSeconds on /Sessions. Emby's documented
  // SessionService does not, so CAPTAiNFiN applies the same freshness filter
  // locally in responseBody instead of sending an undocumented query option.
  if(canonical==='/Sessions')parsed.searchParams.delete('activeWithinSeconds');
  const normalized=`${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (normalized === '/emby' || normalized.startsWith('/emby/')) return normalized;
  return `/emby${normalized}`;
}

function healthEndpoint(type) {
  return normalizeType(type) === 'emby' ? '/System/Info' : '/System/Info/Public';
}

function credentialProbeEndpoint(_type) {
  // Unlike Jellyfin's public health endpoint, /System/Info requires the supplied
  // server credential and therefore proves both reachability and API-key validity.
  return '/System/Info';
}

function userPolicyOverrides(type) {
  if (normalizeType(type) !== 'emby') return null;
  return {
    AuthenticationProviderId: undefined,
    PasswordResetProviderId: undefined
  };
}

function userPolicy(type, policy) {
  const provider = normalizeType(type);
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return policy;
  const overrides = userPolicyOverrides(provider);
  if (!overrides) return policy;
  const result = { ...policy };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete result[key];
    else result[key] = value;
  }
  return result;
}

function requestBody(type, endpoint, body) {
  if (body === null || body === undefined) return body;
  const provider = normalizeType(type), path = canonicalPath(endpoint);
  if (/^\/Users\/[^/]+\/Policy$/.test(path)) return userPolicy(provider, body);
  if (provider === 'emby' && path === '/Users/New' && body && typeof body === 'object' && !Array.isArray(body)) {
    const result = { ...body };
    delete result.Password;
    return result;
  }
  return body;
}

function needsPostCreatePassword(type, endpoint, originalBody) {
  return normalizeType(type) === 'emby'
    && canonicalPath(endpoint) === '/Users/New'
    && typeof originalBody?.Password === 'string'
    && originalBody.Password.length > 0;
}

function responseBody(type, endpoint, body, { now = Date.now() } = {}) {
  if (normalizeType(type) !== 'emby' || canonicalPath(endpoint) !== '/Sessions' || !Array.isArray(body)) return body;
  const parsed=new URL(String(endpoint||''),'http://media.invalid');
  const activeWithinSeconds=Number(parsed.searchParams.get('activeWithinSeconds'));
  const cutoff=Number.isFinite(activeWithinSeconds)&&activeWithinSeconds>0 ? Number(now)-activeWithinSeconds*1000 : null;
  return body
    .filter(session=>{
      if(cutoff===null)return true;
      const activity=new Date(session?.LastActivityDate||0).getTime();
      return Number.isFinite(activity)&&activity>=cutoff;
    })
    .map(session=>({
      ...session,
      SupportsMediaControl: session?.SupportsMediaControl===true || session?.SupportsRemoteControl===true
    }));
}

module.exports = { TYPES, normalizeType, label, authHeaders, apiPath, healthEndpoint, credentialProbeEndpoint, canonicalPath, userPolicyOverrides, userPolicy, requestBody, needsPostCreatePassword, responseBody };
