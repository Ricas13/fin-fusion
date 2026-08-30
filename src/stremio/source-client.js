'use strict';

const outbound=require('../security/outbound-url-policy');
const registry=require('../jellyfin/registry');
const {encryptWithEnv,decryptWithEnv}=require('../security/purpose-crypto');

const TOKEN_PREFIX='stremio-source-token';
const PASSWORD_PREFIX='stremio-source-password';
const TOKEN_ENV='JELLYFIN_ENCRYPTION_KEY';
const LEGACY_TOKEN_ENV='STREMIO_JELLYFIN_TOKEN_KEY';
function providerType(value){return registry.mediaProvider.normalizeType(value);}
function providerLabel(value){return registry.mediaProvider.label(providerType(value));}
function cleanUrl(value,type='jellyfin'){
  const label=providerLabel(type);let url;
  try{url=new URL(String(value||'').trim());}catch{throw new Error(`Enter a valid ${label} URL.`);}
  if(!['http:','https:'].includes(url.protocol))throw new Error(`${label} URL must use HTTP or HTTPS.`);
  if(url.username||url.password||url.hash)throw new Error(`${label} URL may not contain credentials or fragments.`);
  url.search='';url.hash='';url.pathname=url.pathname.replace(/\/+$/,'');return url.toString().replace(/\/$/,'');
}
function sourceUrl(baseUrl,endpoint,type='jellyfin'){
  if(typeof endpoint!=='string'||!endpoint.startsWith('/')||endpoint.startsWith('//'))throw new Error('Invalid media-server source endpoint.');
  const base=cleanUrl(baseUrl,type),root=new URL(base),url=registry.mediaProvider.apiUrl(root,providerType(type),endpoint);
  if(url.origin!==root.origin)throw new Error('Media-server source endpoint escaped the configured server origin.');
  return url;
}
function cleanUsername(value,type='jellyfin'){const username=String(value||'').trim();if(!username||username.length>120)throw new Error(`Enter the ${providerLabel(type)} username.`);return username;}
function clientAuthorization(type='jellyfin'){return registry.mediaProvider.clientAuthorization(providerType(type));}
function userTokenHeaders(type,token){return registry.mediaProvider.userTokenHeaders(providerType(type),token);}
function jellyfinAuthHeader(token){if(/[\r\n]/.test(String(token||'')))throw new Error('Invalid Jellyfin access token.');return `MediaBrowser Token="${token}"`;}
function encryptToken(token){return encryptWithEnv(token,TOKEN_ENV,TOKEN_PREFIX);}
function encryptPassword(password){return encryptWithEnv(password,TOKEN_ENV,PASSWORD_PREFIX);}
function decryptPassword(payload){return decryptWithEnv(payload,TOKEN_ENV,PASSWORD_PREFIX);}
function decryptToken(payload){try{return decryptWithEnv(payload,TOKEN_ENV,TOKEN_PREFIX);}catch(primary){try{return decryptWithEnv(payload,LEGACY_TOKEN_ENV,TOKEN_PREFIX);}catch(_legacy){throw primary;}}}
async function parseJson(response,label='Media server'){const text=await response.text();if(!text)return{};try{return JSON.parse(text);}catch{throw new Error(`${label} returned an unexpected response.`);}}
function sourceError(message,{code='STREMIO_SOURCE_CONNECTION',hint='',detail='',status=null,cause=null}={}){const error=new Error(message);error.code=code;if(hint)error.hint=hint;if(detail)error.detail=detail;if(status!=null)error.status=status;if(cause)error.cause=cause;return error;}
function connectionDiagnosis(error,baseUrl,type='jellyfin'){
  const label=providerLabel(type),message=String(error?.message||error||'').replace(/\s+/g,' ').trim(),code=String(error?.code||error?.cause?.code||'').trim();
  if(/private address that is not explicitly allowed/i.test(message))return sourceError(`CAPTAiNFiN blocked this ${label} URL because it resolves to a private address that is not trusted.`,{code:'STREMIO_SOURCE_OUTBOUND_POLICY',hint:`Enable private integrations and add the ${label} hostname or network CIDR to trusted outbound destinations, then retry.`,detail:message,cause:error});
  if(/resolved to a blocked/i.test(message))return sourceError(`CAPTAiNFiN blocked this ${label} URL because DNS resolved to a reserved or unsafe address.`,{code:'STREMIO_SOURCE_OUTBOUND_POLICY',hint:`Check the ${label} URL hostname and trusted outbound destinations.`,detail:message,cause:error});
  if(/hostname did not resolve|ENOTFOUND|EAI_AGAIN/i.test(message)||['ENOTFOUND','EAI_AGAIN'].includes(code))return sourceError(`CAPTAiNFiN could not resolve the ${label} hostname.`,{code:'STREMIO_SOURCE_DNS',hint:`Check the ${label} URL spelling and DNS from the CAPTAiNFiN host.`,detail:message,cause:error});
  if(/ECONNREFUSED/i.test(message)||code==='ECONNREFUSED')return sourceError(`The ${label} host was reached, but the connection was refused.`,{code:'STREMIO_SOURCE_REFUSED',hint:`Check that ${label} is running and reachable at ${baseUrl}, including the port and reverse proxy route.`,detail:message,cause:error});
  if(/certificate|SELF_SIGNED|UNABLE_TO_VERIFY|CERT_/i.test(message)||/^ERR_TLS|CERT_/i.test(code))return sourceError(`The ${label} HTTPS certificate could not be trusted.`,{code:'STREMIO_SOURCE_TLS',hint:`Use a valid certificate for the ${label} URL or a trusted reverse proxy.`,detail:message,cause:error});
  if(error?.name==='AbortError'||/timed out|timeout|ETIMEDOUT/i.test(message)||code==='ETIMEDOUT')return sourceError(`The ${label} connection timed out before sign-in completed.`,{code:'STREMIO_SOURCE_TIMEOUT',hint:'Check firewall rules, reverse proxy timeouts and connectivity from CAPTAiNFiN.',detail:message,cause:error});
  return sourceError(`CAPTAiNFiN could not reach ${label} for the Stremio source sign-in.`,{code:'STREMIO_SOURCE_CONNECTION',hint:`Verify the ${label} URL and outbound integration policy.`,detail:message,cause:error});
}
function httpDiagnosis(status,type='jellyfin'){
  const label=providerLabel(type),endpoint=providerType(type)==='emby'?'/emby/Users/AuthenticateByName':'/Users/AuthenticateByName';
  if(status===401||status===403)return sourceError(`${label} rejected the username or password.`,{code:'STREMIO_SOURCE_AUTH',status,hint:`Check the dedicated ${label} username/password and account state.`,detail:`${label} returned HTTP ${status} from ${endpoint}.`});
  if(status===404)return sourceError(`${label} sign-in endpoint was not found at this URL.`,{code:'STREMIO_SOURCE_HTTP',status,hint:`Check the ${label} URL and reverse-proxy base path.`,detail:`${label} returned HTTP 404 from ${endpoint}.`});
  if(status===429)return sourceError(`${label} rate-limited the sign-in attempt.`,{code:'STREMIO_SOURCE_HTTP',status,hint:'Wait a moment and retry.',detail:`${label} returned HTTP 429 from ${endpoint}.`});
  if(status>=500)return sourceError(`${label} returned a server error while signing in.`,{code:'STREMIO_SOURCE_HTTP',status,hint:`Check ${label} and reverse-proxy logs.`,detail:`${label} returned HTTP ${status} from ${endpoint}.`});
  return sourceError(`${label} sign-in failed with HTTP ${status}.`,{code:'STREMIO_SOURCE_HTTP',status,hint:`Check the ${label} URL, account state and reverse proxy.`,detail:`${label} returned HTTP ${status} from ${endpoint}.`});
}
async function authenticateOnce(base,user,secret,type='jellyfin'){
  const provider=providerType(type),label=providerLabel(provider),url=sourceUrl(base,'/Users/AuthenticateByName',provider);let response;
  try{response=await outbound.safeFetch(url,{purpose:`Stremio external ${label} sign-in`,method:'POST',timeoutMs:12000,maxBytes:1024*1024,headers:{Authorization:clientAuthorization(provider),Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({Username:user,Pw:secret})});}catch(error){throw connectionDiagnosis(error,base,provider);}
  if(!response.ok)throw httpDiagnosis(response.status,provider);
  const body=await parseJson(response,label),token=String(body.AccessToken||''),jellyfinUserId=String(body.User?.Id||''),jellyfinUsername=String(body.User?.Name||user);
  if(token.length<8||!jellyfinUserId)throw sourceError(`${label} signed in but did not return a usable user session.`,{code:'STREMIO_SOURCE_BAD_SESSION',hint:`Check whether the user can sign in normally and whether the ${label} API response is modified by a reverse proxy.`,detail:'Missing AccessToken or User.Id in the sign-in response.'});
  return{baseUrl:base,publicUrl:base,jellyfinUserId,jellyfinUsername,accessToken:token,mediaServerType:provider};
}
async function authenticate(baseUrl,username,password,type='jellyfin'){
  const provider=providerType(type),base=cleanUrl(baseUrl,provider),user=cleanUsername(username,provider),secret=String(password||'');if(!secret)throw new Error(`Enter the ${providerLabel(provider)} password.`);
  try{return await authenticateOnce(base,user,secret,provider);}catch(error){const compactUser=user.replace(/\s+/g,'');if(error?.code==='STREMIO_SOURCE_AUTH'&&/\s/.test(user)&&compactUser&&compactUser!==user){try{return await authenticateOnce(base,compactUser,secret,provider);}catch(retryError){retryError.detail=[retryError.detail,`A retry also failed after removing whitespace from the username (${compactUser}).`].filter(Boolean).join(' ');throw retryError;}}throw error;}
}
function sourceToken(source){return decryptToken(source.access_token_encrypted);}
async function logoutToken(baseUrl,token,sourceName='Media server',type='jellyfin'){if(!baseUrl||!token)return false;const provider=providerType(type),label=providerLabel(provider);try{const response=await outbound.safeFetch(sourceUrl(baseUrl,'/Sessions/Logout',provider),{purpose:`Stremio source logout on ${sourceName||label}`,method:'POST',timeoutMs:8000,maxBytes:1024*1024,headers:userTokenHeaders(provider,token)});return response.ok||response.status===401||response.status===403;}catch(_error){return false;}}
async function logout(source){if(!source?.access_token_encrypted)return false;return logoutToken(source.base_url,sourceToken(source),source.name||providerLabel(source.media_server_type),source.media_server_type);}
async function request(source,endpoint,{method='GET',body=null,timeoutMs=15000,maxBytes=8*1024*1024}={}){
  const provider=providerType(source.media_server_type),label=providerLabel(provider),url=sourceUrl(source.base_url,endpoint,provider),headers=userTokenHeaders(provider,sourceToken(source));if(body!=null)headers['Content-Type']='application/json';
  const response=await outbound.safeFetch(url,{purpose:`Stremio source request on ${source.name||label}`,method,timeoutMs,maxBytes,headers,body:body==null?undefined:JSON.stringify(body)});
  if(response.status===401||response.status===403){const error=new Error(`${label} authentication expired. Reconnect this Stremio source.`);error.code='STREMIO_SOURCE_AUTH';throw error;}
  if(!response.ok)throw new Error(`${label} source returned HTTP ${response.status}.`);return parseJson(response,label);
}
async function discoverLibraries(source){const payload=await request(source,`/Users/${encodeURIComponent(source.jellyfin_user_id)}/Views?IncludeExternalContent=false`,{maxBytes:4*1024*1024}),supported=new Set(['movies','tvshows','mixed']);return(Array.isArray(payload.Items)?payload.Items:[]).map(item=>({libraryId:String(item.Id||''),name:String(item.Name||'Library'),collectionType:String(item.CollectionType||'').toLowerCase()})).filter(item=>item.libraryId&&supported.has(item.collectionType));}

module.exports={TOKEN_PREFIX,PASSWORD_PREFIX,TOKEN_ENV,LEGACY_TOKEN_ENV,providerType,providerLabel,cleanUrl,sourceUrl,cleanUsername,clientAuthorization,userTokenHeaders,jellyfinAuthHeader,encryptToken,decryptToken,encryptPassword,decryptPassword,sourceError,connectionDiagnosis,httpDiagnosis,authenticate,sourceToken,logoutToken,logout,request,discoverLibraries};
