'use strict';

const TYPES = Object.freeze(['jellyfin', 'emby']);

function normalizeType(value) {
  const type = String(value || 'jellyfin').trim().toLowerCase();
  if (!TYPES.includes(type)) throw new Error(`Unsupported media server type: ${type}`);
  return type;
}
function label(value) { return normalizeType(value) === 'emby' ? 'Emby' : 'Jellyfin'; }
function validToken(value, description) { const token=String(value||'').trim();if(!token)throw new Error(`${description} is required.`);if(/[\r\n]/.test(token))throw new Error(`${description} contains invalid characters.`);return token; }
function authHeaders(type, apiKey, { jsonBody = false } = {}) { const provider=normalizeType(type),token=validToken(apiKey,`${label(provider)} API key`),auth=provider==='emby'?{'X-Emby-Token':token}:{Authorization:`MediaBrowser Token="${token}"`};return{...auth,Accept:'application/json',...(jsonBody?{'Content-Type':'application/json'}:{})}; }
function userTokenHeaders(type, accessToken, {jsonBody=false}={}) { const provider=normalizeType(type),token=validToken(accessToken,`${label(provider)} user token`),auth=provider==='emby'?{'X-Emby-Token':token}:{Authorization:`MediaBrowser Token="${token}"`};return{...auth,Accept:'application/json',...(jsonBody?{'Content-Type':'application/json'}:{})}; }
function clientAuthorization(type,{userId=''}={}) { const provider=normalizeType(type),prefix=provider==='emby'?'Emby':'MediaBrowser',id=String(userId||'').trim(),fields=[id?`UserId="${id}"`:null,'Client="CAPTAiNFiN Stremio"','Device="CAPTAiNFiN"','DeviceId="captainfin-stremio"','Version="2.0"'].filter(Boolean);return`${prefix} ${fields.join(', ')}`; }
function canonicalPath(endpoint) { const parsed=new URL(String(endpoint||''),'http://media.invalid');return parsed.pathname.replace(/^\/emby(?=\/|$)/,'')||'/'; }
function apiPath(type, endpoint) {
  const provider=normalizeType(type),path=String(endpoint||'');
  if(!path.startsWith('/')||path.startsWith('//'))throw new Error('Invalid media server API endpoint.');
  if(provider!=='emby')return path;
  const parsed=new URL(path,'http://media.invalid'),canonical=parsed.pathname.replace(/^\/emby(?=\/|$)/,'')||'/';
  if(canonical==='/Sessions')parsed.searchParams.delete('activeWithinSeconds');
  const normalized=`${parsed.pathname}${parsed.search}${parsed.hash}`;
  if(normalized==='/emby'||normalized.startsWith('/emby/'))return normalized;
  return`/emby${normalized}`;
}
function apiUrl(baseUrl,type,endpoint) {
  const provider=normalizeType(type),base=new URL(String(baseUrl)),api=new URL(apiPath(provider,endpoint),'http://media.invalid');
  let basePath=base.pathname.replace(/\/+$/,'');
  let apiPathname=api.pathname;
  // Accept either a server root (https://host) or an Emby API root
  // (https://host/emby) without producing /emby/emby. Other reverse-proxy
  // prefixes are retained verbatim, e.g. /media/emby/Users.
  if(provider==='emby'&&/(^|\/)emby$/i.test(basePath)&&apiPathname.startsWith('/emby'))apiPathname=apiPathname.slice(5)||'/';
  base.pathname=`${basePath}${apiPathname}`.replace(/\/{2,}/g,'/')||'/';
  base.search=api.search;base.hash=api.hash;
  return base;
}
function healthEndpoint(type) { return normalizeType(type)==='emby'?'/System/Info':'/System/Info/Public'; }
function credentialProbeEndpoint(_type) { return'/System/Info'; }
function userPolicyOverrides(type) { if(normalizeType(type)!=='emby')return null;return{AuthenticationProviderId:undefined,PasswordResetProviderId:undefined,SyncPlayAccess:undefined}; }
function userPolicy(type,policy) { const provider=normalizeType(type);if(!policy||typeof policy!=='object'||Array.isArray(policy))return policy;const overrides=userPolicyOverrides(provider);if(!overrides)return policy;const result={...policy};for(const[key,value]of Object.entries(overrides)){if(value===undefined)delete result[key];else result[key]=value;}return result; }
function requestBody(type,endpoint,body) { if(body===null||body===undefined)return body;const provider=normalizeType(type),path=canonicalPath(endpoint);if(/^\/Users\/[^/]+\/Policy$/.test(path))return userPolicy(provider,body);if(provider==='emby'&&path==='/Users/New'&&body&&typeof body==='object'&&!Array.isArray(body)){const result={...body};delete result.Password;return result;}return body; }
function needsPostCreatePassword(type,endpoint,originalBody) { return normalizeType(type)==='emby'&&canonicalPath(endpoint)==='/Users/New'&&typeof originalBody?.Password==='string'&&originalBody.Password.length>0; }
function responseBody(type,endpoint,body,{now=Date.now()}={}) { if(normalizeType(type)!=='emby'||canonicalPath(endpoint)!=='/Sessions'||!Array.isArray(body))return body;const parsed=new URL(String(endpoint||''),'http://media.invalid'),activeWithinSeconds=Number(parsed.searchParams.get('activeWithinSeconds')),cutoff=Number.isFinite(activeWithinSeconds)&&activeWithinSeconds>0?Number(now)-activeWithinSeconds*1000:null;return body.filter(session=>{if(cutoff===null)return true;const activity=new Date(session?.LastActivityDate||0).getTime();return Number.isFinite(activity)&&activity>=cutoff;}).map(session=>({...session,SupportsMediaControl:session?.SupportsMediaControl===true||session?.SupportsRemoteControl===true})); }

module.exports={TYPES,normalizeType,label,authHeaders,userTokenHeaders,clientAuthorization,apiPath,apiUrl,healthEndpoint,credentialProbeEndpoint,canonicalPath,userPolicyOverrides,userPolicy,requestBody,needsPostCreatePassword,responseBody};
