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
async function authenticate(baseUrl,username,password){
  const base=cleanUrl(baseUrl),user=cleanUsername(username),secret=String(password||'');
  if(!secret)throw new Error('Enter the Jellyfin password.');
  const url=sourceUrl(base,'/Users/AuthenticateByName');
  const response=await outbound.safeFetch(url,{purpose:'Stremio external Jellyfin sign-in',method:'POST',timeoutMs:12000,maxBytes:1024*1024,headers:{Authorization:clientAuthorization(),Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({Username:user,Pw:secret})});
  if(response.status===401||response.status===403)throw new Error('Jellyfin rejected the username or password.');
  if(!response.ok)throw new Error(`Jellyfin sign-in failed with HTTP ${response.status}.`);
  const body=await parseJson(response),token=String(body.AccessToken||''),jellyfinUserId=String(body.User?.Id||''),jellyfinUsername=String(body.User?.Name||user);
  if(token.length<8||!jellyfinUserId)throw new Error('Jellyfin signed in but did not return a usable user session.');
  return{baseUrl:base,publicUrl:base,jellyfinUserId,jellyfinUsername,accessToken:token};
}
function sourceToken(source){return decryptToken(source.access_token_encrypted);}
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

module.exports={TOKEN_PREFIX,TOKEN_ENV,LEGACY_TOKEN_ENV,cleanUrl,sourceUrl,cleanUsername,clientAuthorization,jellyfinAuthHeader,encryptToken,decryptToken,authenticate,sourceToken,request,discoverLibraries};
