'use strict';

const outbound=require('../security/outbound-url-policy');
const {encryptWithEnv,decryptWithEnv}=require('../security/purpose-crypto');

const TOKEN_PREFIX='stremio-source-token';
const TOKEN_ENV='JELLYFIN_ENCRYPTION_KEY';
const LEGACY_TOKEN_ENV='STREMIO_JELLYFIN_TOKEN_KEY';

function cleanUrl(value){
  let url;
  try{url=new URL(String(value||'').trim());}catch{throw new Error('Enter a valid Jellyfin URL.');}
  if(!['http:','https:'].includes(url.protocol))throw new Error('Jellyfin URL must use HTTP or HTTPS.');
  if(url.username||url.password||url.hash)throw new Error('Jellyfin URL may not contain credentials or fragments.');
  url.search='';url.hash='';url.pathname=url.pathname.replace(/\/+$/,'');
  return url.toString().replace(/\/$/,'');
}
function sourceUrl(baseUrl,endpoint){
  if(typeof endpoint!=='string'||!endpoint.startsWith('/')||endpoint.startsWith('//'))throw new Error('Invalid Jellyfin source endpoint.');
  const base=cleanUrl(baseUrl),root=new URL(`${base}/`),url=new URL(endpoint.slice(1),root);
  if(url.origin!==root.origin)throw new Error('Jellyfin source endpoint escaped the configured server origin.');
  const prefix=root.pathname.endsWith('/')?root.pathname:root.pathname+'/';
  if(prefix!=='/'&&!url.pathname.startsWith(prefix))throw new Error('Jellyfin source endpoint escaped the configured server base path.');
  return url;
}
function cleanUsername(value){const username=String(value||'').trim();if(!username||username.length>120)throw new Error('Enter the Jellyfin username.');return username;}
function clientAuthorization(){return 'MediaBrowser Client="CAPTAiNFiN Stremio Source", Device="CAPTAiNFiN", DeviceId="captainfin-stremio-source", Version="1.0"';}
function jellyfinAuthHeader(token){if(/[\r\n]/.test(String(token||'')))throw new Error('Invalid Jellyfin access token.');return `MediaBrowser Token="${token}"`;}
function encryptToken(token){return encryptWithEnv(token,TOKEN_ENV,TOKEN_PREFIX);}
function decryptToken(payload){
  try{return decryptWithEnv(payload,TOKEN_ENV,TOKEN_PREFIX);}catch(primary){
    try{return decryptWithEnv(payload,LEGACY_TOKEN_ENV,TOKEN_PREFIX);}catch(_legacy){throw primary;}
  }
}
async function parseJson(response){const text=await response.text();if(!text)return{};try{return JSON.parse(text);}catch{throw new Error('Jellyfin returned an unexpected response.');}}
function sourceError(message,{code='STREMIO_SOURCE_CONNECTION',hint='',detail='',status=null,cause=null}={}){
  const error=new Error(message);
  error.code=code;
  if(hint)error.hint=hint;
  if(detail)error.detail=detail;
  if(status!=null)error.status=status;
  if(cause)error.cause=cause;
  return error;
}
function connectionDiagnosis(error,baseUrl){
  const message=String(error?.message||error||'').replace(/\s+/g,' ').trim(),code=String(error?.code||error?.cause?.code||'').trim();
  if(/private address that is not explicitly allowed/i.test(message))return sourceError('CAPTAiNFiN blocked this Jellyfin URL because it resolves to a private address that is not trusted.',{code:'STREMIO_SOURCE_OUTBOUND_POLICY',hint:'In Admin Settings, enable private integrations and add the Jellyfin hostname or network CIDR to trusted outbound destinations, then retry.',detail:message,cause:error});
  if(/resolved to a blocked/i.test(message))return sourceError('CAPTAiNFiN blocked this Jellyfin URL because DNS resolved to a reserved or unsafe address.',{code:'STREMIO_SOURCE_OUTBOUND_POLICY',hint:'Check the Jellyfin URL hostname. If this is a private server, add the exact trusted hostname or CIDR before retrying.',detail:message,cause:error});
  if(/hostname did not resolve|ENOTFOUND|EAI_AGAIN/i.test(message)||['ENOTFOUND','EAI_AGAIN'].includes(code))return sourceError('CAPTAiNFiN could not resolve the Jellyfin hostname.',{code:'STREMIO_SOURCE_DNS',hint:'Check the Jellyfin URL spelling and DNS from the CAPTAiNFiN host.',detail:message,cause:error});
  if(/ECONNREFUSED/i.test(message)||code==='ECONNREFUSED')return sourceError('The Jellyfin host was reached, but the connection was refused.',{code:'STREMIO_SOURCE_REFUSED',hint:`Check that Jellyfin is running and reachable at ${baseUrl}, including the port and reverse proxy route.`,detail:message,cause:error});
  if(/certificate|SELF_SIGNED|UNABLE_TO_VERIFY|CERT_/i.test(message)||/^ERR_TLS|CERT_/i.test(code))return sourceError('The Jellyfin HTTPS certificate could not be trusted.',{code:'STREMIO_SOURCE_TLS',hint:'Use a valid certificate for the Jellyfin URL or connect through a trusted reverse proxy.',detail:message,cause:error});
  if(error?.name==='AbortError'||/timed out|timeout|ETIMEDOUT/i.test(message)||code==='ETIMEDOUT')return sourceError('The Jellyfin connection timed out before sign-in completed.',{code:'STREMIO_SOURCE_TIMEOUT',hint:'Check firewall rules, reverse proxy timeouts and whether the CAPTAiNFiN host can reach the Jellyfin URL.',detail:message,cause:error});
  return sourceError('CAPTAiNFiN could not reach Jellyfin for the Stremio source sign-in.',{code:'STREMIO_SOURCE_CONNECTION',hint:'Verify the Jellyfin URL from the CAPTAiNFiN server and check outbound integration policy if the server is private.',detail:message,cause:error});
}
function httpDiagnosis(status){
  if(status===401||status===403)return sourceError('Jellyfin rejected the username or password.',{code:'STREMIO_SOURCE_AUTH',status,hint:'Check the dedicated Jellyfin username/password, confirm the account is enabled, and make sure the reverse proxy is not blocking API sign-in.',detail:`Jellyfin returned HTTP ${status} from /Users/AuthenticateByName.`});
  if(status===404)return sourceError('Jellyfin sign-in endpoint was not found at this URL.',{code:'STREMIO_SOURCE_HTTP',status,hint:'Check whether the Jellyfin URL needs a base path, for example https://host/jellyfin, and make sure it points to Jellyfin rather than another service.',detail:'Jellyfin returned HTTP 404 from /Users/AuthenticateByName.'});
  if(status===429)return sourceError('Jellyfin rate-limited the sign-in attempt.',{code:'STREMIO_SOURCE_HTTP',status,hint:'Wait a moment, then retry. If this repeats, check Jellyfin or reverse-proxy rate limits for the CAPTAiNFiN host.',detail:'Jellyfin returned HTTP 429 from /Users/AuthenticateByName.'});
  if(status>=500)return sourceError('Jellyfin returned a server error while signing in.',{code:'STREMIO_SOURCE_HTTP',status,hint:'Check the Jellyfin server logs and reverse proxy logs for the failed sign-in request.',detail:`Jellyfin returned HTTP ${status} from /Users/AuthenticateByName.`});
  return sourceError(`Jellyfin sign-in failed with HTTP ${status}.`,{code:'STREMIO_SOURCE_HTTP',status,hint:'Check the Jellyfin URL, account state and reverse proxy response for API sign-in.',detail:`Jellyfin returned HTTP ${status} from /Users/AuthenticateByName.`});
}
async function authenticateOnce(base,user,secret){
  const url=sourceUrl(base,'/Users/AuthenticateByName');
  let response;
  try{
    response=await outbound.safeFetch(url,{purpose:'Stremio external Jellyfin sign-in',method:'POST',timeoutMs:12000,maxBytes:1024*1024,headers:{Authorization:clientAuthorization(),Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({Username:user,Pw:secret})});
  }catch(error){throw connectionDiagnosis(error,base);}
  if(!response.ok)throw httpDiagnosis(response.status);
  const body=await parseJson(response),token=String(body.AccessToken||''),jellyfinUserId=String(body.User?.Id||''),jellyfinUsername=String(body.User?.Name||user);
  if(token.length<8||!jellyfinUserId)throw sourceError('Jellyfin signed in but did not return a usable user session.',{code:'STREMIO_SOURCE_BAD_SESSION',hint:'Check whether the user can sign in normally and whether the Jellyfin API response is being modified by a reverse proxy.',detail:'Missing AccessToken or User.Id in the sign-in response.'});
  return{baseUrl:base,publicUrl:base,jellyfinUserId,jellyfinUsername,accessToken:token};
}
async function authenticate(baseUrl,username,password){
  const base=cleanUrl(baseUrl),user=cleanUsername(username),secret=String(password||'');
  if(!secret)throw new Error('Enter the Jellyfin password.');
  try{
    return await authenticateOnce(base,user,secret);
  }catch(error){
    const compactUser=user.replace(/\s+/g,'');
    if(error?.code==='STREMIO_SOURCE_AUTH'&&/\s/.test(user)&&compactUser&&compactUser!==user){
      try{return await authenticateOnce(base,compactUser,secret);}
      catch(retryError){
        retryError.hint=retryError.hint||'Jellyfin rejected the username or password.';
        retryError.detail=[retryError.detail,`A retry also failed after removing whitespace from the username (${compactUser}).`].filter(Boolean).join(' ');
        throw retryError;
      }
    }
    throw error;
  }
}
function sourceToken(source){return decryptToken(source.access_token_encrypted);}
async function logout(source){
  if(!source?.access_token_encrypted)return false;
  try{
    const response=await outbound.safeFetch(sourceUrl(source.base_url,'/Sessions/Logout'),{purpose:`Stremio source logout on ${source.name||'Jellyfin'}`,method:'POST',timeoutMs:8000,maxBytes:1024*1024,headers:{Authorization:jellyfinAuthHeader(sourceToken(source)),Accept:'application/json'}});
    return response.ok;
  }catch(_error){return false;}
}
async function request(source,endpoint,{method='GET',body=null,timeoutMs=15000,maxBytes=8*1024*1024}={}){
  const url=sourceUrl(source.base_url,endpoint),headers={Authorization:jellyfinAuthHeader(sourceToken(source)),Accept:'application/json'};
  if(body!=null)headers['Content-Type']='application/json';
  const response=await outbound.safeFetch(url,{purpose:`Stremio source request on ${source.name||'Jellyfin'}`,method,timeoutMs,maxBytes,headers,body:body==null?undefined:JSON.stringify(body)});
  if(response.status===401||response.status===403){const error=new Error('Jellyfin authentication expired. Reconnect this Stremio source.');error.code='STREMIO_SOURCE_AUTH';throw error;}
  if(!response.ok)throw new Error(`Jellyfin source returned HTTP ${response.status}.`);
  return parseJson(response);
}
async function discoverLibraries(source){
  const payload=await request(source,`/Users/${encodeURIComponent(source.jellyfin_user_id)}/Views?IncludeExternalContent=false`,{maxBytes:4*1024*1024});
  const supported=new Set(['movies','tvshows','mixed']);
  return (Array.isArray(payload.Items)?payload.Items:[]).map(item=>({libraryId:String(item.Id||''),name:String(item.Name||'Library'),collectionType:String(item.CollectionType||'').toLowerCase()})).filter(item=>item.libraryId&&supported.has(item.collectionType));
}

module.exports={TOKEN_PREFIX,TOKEN_ENV,LEGACY_TOKEN_ENV,cleanUrl,sourceUrl,cleanUsername,clientAuthorization,jellyfinAuthHeader,encryptToken,decryptToken,sourceError,connectionDiagnosis,httpDiagnosis,authenticate,sourceToken,logout,request,discoverLibraries};
