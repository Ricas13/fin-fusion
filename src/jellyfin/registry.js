'use strict';

const { query } = require('../db');
const { decryptString } = require('../crypto');
const { decryptWithEnv } = require('../security/purpose-crypto');
const outbound=require('../security/outbound-url-policy');
const mediaProvider=require('../media-servers/provider');

function normalizeBaseUrl(value) {
    let parsed;
    try { parsed = new URL(String(value || '').trim()); }
    catch (_) { throw new Error('Enter a valid Jellyfin/Emby http/https URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http and https media-server URLs are allowed.');
    if (parsed.username || parsed.password || parsed.hash) throw new Error('Media-server URLs may not contain credentials or fragments.');
    if (!parsed.hostname) throw new Error('Media-server URL hostname is required.');
    parsed.search='';parsed.hash='';parsed.pathname=parsed.pathname.replace(/\/+$/,'');
    return parsed.toString().replace(/\/$/,'');
}
function authHeaders(apiKey,{jsonBody=false,mediaServerType='jellyfin'}={}){return mediaProvider.authHeaders(mediaServerType,apiKey,{jsonBody});}
function decryptJellyfinKey(payload){if(!payload)return null;if(String(payload).startsWith('jf1:'))return decryptWithEnv(payload,'JELLYFIN_ENCRYPTION_KEY','jf1');if(String(payload).startsWith('v1:')&&process.env.ALLOW_LEGACY_DATA_KEY_FOR_JELLYFIN==='true'&&process.env.DATA_ENCRYPTION_KEY)return decryptString(payload);if(String(payload).startsWith('v1:'))throw new Error('Legacy Jellyfin key must be rotated to JELLYFIN_ENCRYPTION_KEY');throw new Error('Unsupported Jellyfin key format');}
async function listServers({enabledOnly=true,serverClass=null}={}){const params=[],where=[];if(enabledOnly)where.push('enabled = TRUE');if(serverClass){params.push(serverClass);where.push(`server_class = $${params.length}`);}const result=await query(`SELECT id,name,slug,server_class,media_server_type,base_url,public_url,enabled,priority,max_users,health_status,last_health_check FROM jellyfin_servers ${where.length?`WHERE ${where.join(' AND ')}`:''} ORDER BY priority ASC, name ASC`,params);return result.rows;}
async function getServerSecret(serverId){const result=await query(`SELECT id,name,slug,server_class,media_server_type,base_url,public_url,enabled,priority,max_users,api_key_encrypted FROM jellyfin_servers WHERE id=$1`,[serverId]);if(!result.rowCount)return null;const server=result.rows[0];return{...server,media_server_type:mediaProvider.normalizeType(server.media_server_type),base_url:normalizeBaseUrl(server.base_url),apiKey:decryptJellyfinKey(server.api_key_encrypted)};}

function operationError(server,method,url,timeoutMs,error){
    const verb=String(method||'GET').toUpperCase(),path=url.pathname||'/',message=String(error?.message||error||'request failed');
    const timedOut=error?.name==='AbortError'||/timed out/i.test(message);
    const type=mediaProvider.normalizeType(server.media_server_type),providerLabel=mediaProvider.label(type),prefix=type==='emby'?'EMBY':'JELLYFIN';
    const wrapped=new Error(timedOut
        ? `${providerLabel} ${server.name} ${verb} ${path} timed out after ${Math.round(Number(timeoutMs||10000)/1000)}s`
        : `${providerLabel} ${server.name} ${verb} ${path} request failed: ${message}`);
    wrapped.code=timedOut?`${prefix}_TIMEOUT`:`${prefix}_REQUEST_FAILED`;
    wrapped.retryable=timedOut;
    wrapped.operation={provider:type,method:verb,path,timeoutMs:Number(timeoutMs||10000)};
    wrapped.cause=error;
    return wrapped;
}

async function request(serverId,endpoint,{method='GET',body=null,timeoutMs=10000}={}){
    const server=await getServerSecret(serverId);
    if(!server||!server.enabled)throw new Error('Media server is unavailable or disabled');
    const apiPath=mediaProvider.apiPath(server.media_server_type,endpoint);
    const url=new URL(apiPath,`${server.base_url}/`);
    if(url.origin!==new URL(server.base_url).origin)throw new Error('Media-server API endpoint escaped the configured server origin.');
    let response;
    try{
        response=await outbound.safeFetch(url,{purpose:`${mediaProvider.label(server.media_server_type)} server ${server.name}`,method,timeoutMs,headers:authHeaders(server.apiKey,{jsonBody:Boolean(body),mediaServerType:server.media_server_type}),...(body?{body:JSON.stringify(body)}:{})});
    }catch(error){
        throw operationError(server,method,url,timeoutMs,error);
    }
    const text=await response.text();let parsed=null;if(text){try{parsed=JSON.parse(text)}catch{parsed=text}}
    if(!response.ok){
        const verb=String(method||'GET').toUpperCase(),path=url.pathname||'/',providerLabel=mediaProvider.label(server.media_server_type);
        const err=new Error(`${providerLabel} ${server.name} ${verb} ${path} returned HTTP ${response.status}`);
        err.status=response.status;err.response=parsed;err.operation={provider:server.media_server_type,method:verb,path,timeoutMs:Number(timeoutMs||10000)};
        err.retryable=response.status===408||response.status===429||response.status>=500;
        throw err;
    }
    return parsed??{};
}

async function healthcheckServer(serverId){
    const started=Date.now();
    try{
        const server=await getServerSecret(serverId);
        if(!server||!server.enabled)throw new Error('Media server is unavailable or disabled');
        const info=await request(serverId,mediaProvider.healthEndpoint(server.media_server_type),{timeoutMs:5000});
        await query(`UPDATE jellyfin_servers SET health_status='healthy',last_health_check=NOW(),updated_at=NOW() WHERE id=$1`,[serverId]);
        return{ok:true,latencyMs:Date.now()-started,provider:server.media_server_type,info};
    }catch(err){
        // A single 5-second miss is not enough evidence to call the server
        // offline. Mark the first miss degraded; the next consecutive failed
        // health run promotes it to offline. A success always resets healthy.
        await query(`UPDATE jellyfin_servers SET health_status=CASE WHEN health_status IN('degraded','offline') THEN 'offline' ELSE 'degraded' END,last_health_check=NOW(),updated_at=NOW() WHERE id=$1`,[serverId]);
        return{ok:false,latencyMs:Date.now()-started,error:err.message};
    }
}
module.exports={normalizeBaseUrl,authHeaders,listServers,getServerSecret,request,healthcheckServer,decryptJellyfinKey,operationError,mediaProvider};
