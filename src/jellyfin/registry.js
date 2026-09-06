'use strict';

const { query } = require('../db');
const { decryptString } = require('../crypto');
const { decryptWithEnv } = require('../security/purpose-crypto');
const outbound=require('../security/outbound-url-policy');
const mediaProvider=require('../media-servers/provider');

const responseCache=new Map();

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

function jellyfinUserMutationTarget(endpoint,method){
    const verb=String(method||'GET').toUpperCase();
    if(!['POST','PUT','PATCH','DELETE'].includes(verb))return null;
    const match=String(endpoint||'').match(/^\/Users\/([^/?]+)(?:\/([^?]+))?(?:\?.*)?$/i);
    if(!match)return null;
    let userId;
    try{userId=decodeURIComponent(match[1]);}catch{return null;}
    if(!userId||/^(New|AuthenticateByName|AuthenticateWithQuickConnect|ForgotPassword)$/i.test(userId))return null;
    return{userId,verb,suffix:String(match[2]||'').toLowerCase()};
}

function jellyfinUserUpdateBody(endpoint,method,currentUser,body){
    if(String(method||'GET').toUpperCase()!=='POST'||!body||typeof body!=='object'||Array.isArray(body))return body;
    const target=jellyfinUserMutationTarget(endpoint,method);
    if(!target||target.suffix||!currentUser||typeof currentUser!=='object'||Array.isArray(currentUser))return body;
    // Jellyfin's legacy POST /Users/{id} endpoint consumes a UserDto and applies
    // Configuration as part of the update. A minimal {Id,Name} rename payload can
    // therefore be rejected by Jellyfin (or lose user configuration on versions
    // that tolerate it). Preserve the server's current DTO and override only the
    // fields explicitly supplied by CAPTAiNFiN.
    const merged={...currentUser,...body};
    if(body.Configuration===undefined&&currentUser.Configuration!==undefined)merged.Configuration=currentUser.Configuration;
    if(merged.Id===undefined||merged.Id===null||merged.Id==='')merged.Id=currentUser.Id||target.userId;
    return merged;
}

async function assertJellyfinAdministratorProtected(server,endpoint,method,timeoutMs){
    if(mediaProvider.normalizeType(server.media_server_type)!=='jellyfin')return null;
    const target=jellyfinUserMutationTarget(endpoint,method);
    if(!target)return null;
    const apiPath=mediaProvider.apiPath('jellyfin',`/Users/${encodeURIComponent(target.userId)}`);
    const url=new URL(apiPath,`${server.base_url}/`);
    if(url.origin!==new URL(server.base_url).origin)throw new Error('Media-server API endpoint escaped the configured server origin.');
    let response;
    try{
        response=await outbound.safeFetch(url,{
            purpose:`Jellyfin administrator protection check on ${server.name}`,
            method:'GET',
            timeoutMs:Math.min(Number(timeoutMs||10000),5000),
            headers:authHeaders(server.apiKey,{mediaServerType:'jellyfin'})
        });
    }catch(error){
        const protectedError=operationError(server,'GET',url,Math.min(Number(timeoutMs||10000),5000),error);
        protectedError.code='JELLYFIN_ADMIN_PROTECTION_CHECK_FAILED';
        throw protectedError;
    }
    const text=await response.text();let parsed=null;if(text){try{parsed=JSON.parse(text)}catch{parsed=text}}
    if(response.status===404&&target.verb==='DELETE')return null;
    if(!response.ok){
        const error=new Error(`Jellyfin administrator protection check for ${target.userId} returned HTTP ${response.status}`);
        error.code='JELLYFIN_ADMIN_PROTECTION_CHECK_FAILED';
        error.status=response.status;
        error.retryable=response.status===408||response.status===429||response.status>=500;
        throw error;
    }
    if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&parsed.Policy?.IsAdministrator===true){
        const error=new Error('Jellyfin administrator accounts are protected and cannot be modified or deleted by CAPTAiNFiN automation.');
        error.code='JELLYFIN_ADMIN_PROTECTED';
        error.retryable=false;
        error.jellyfinUserId=target.userId;
        throw error;
    }
    return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:null;
}

async function managedDevicePolicyBody(serverId,endpoint,method,body,{bypassDevicePolicy=false}={}){
    if(String(method||'GET').toUpperCase()==='POST'&&body&&typeof body==='object'&&!Array.isArray(body)&&/^\/Users\/[^/]+\/Policy(?:\?.*)?$/i.test(String(endpoint||''))&&body.IsDisabled===true){
        const error=new Error('Managed media users cannot be disabled. Remove the account when access ends.');
        error.code='MEDIA_USER_DISABLED_STATE_FORBIDDEN';
        throw error;
    }
    if(bypassDevicePolicy||String(method||'GET').toUpperCase()!=='POST'||!body||typeof body!=='object'||Array.isArray(body))return body;
    const match=String(endpoint||'').match(/^\/Users\/([^/]+)\/Policy(?:\?.*)?$/i);
    if(!match)return body;
    let userId;
    try{userId=decodeURIComponent(match[1]);}catch{return body;}
    const result=await query(`
        SELECT mdp.enforced,mdp.device_limit,
               COALESCE(array_agg(mad.device_id ORDER BY mad.registered_at,mad.device_id) FILTER (WHERE mad.revoked_at IS NULL),'{}'::text[]) AS device_ids
        FROM jellyfin_accounts ja
        JOIN media_account_device_policy mdp ON mdp.jellyfin_account_id=ja.id
        LEFT JOIN media_account_devices mad ON mad.jellyfin_account_id=ja.id
        WHERE ja.server_id=$1 AND lower(ja.jellyfin_user_id)=lower($2)
        GROUP BY mdp.enforced,mdp.device_limit
        LIMIT 1
    `,[serverId,userId]);
    const row=result.rows[0];
    if(!row?.enforced)return body;
    const limit=Number(row.device_limit||0);
    const ids=(Array.isArray(row.device_ids)?row.device_ids:[]).map(value=>String(value||'').trim()).filter(Boolean).slice(0,Math.max(0,limit));
    if(!ids.length)return body;
    return{...body,EnableAllDevices:false,EnabledDevices:ids};
}

function cacheKey(serverId,method,endpoint){return `${String(serverId)}:${String(method||'GET').toUpperCase()}:${String(endpoint||'')}`;}
function clearServerCache(serverId){const prefix=`${String(serverId)}:`;for(const key of responseCache.keys()){if(key.startsWith(prefix))responseCache.delete(key);}}

async function request(serverId,endpoint,{method='GET',body=null,timeoutMs=10000,bypassDevicePolicy=false,cacheTtlMs=0}={}){
    const verb=String(method||'GET').toUpperCase();
    const reusable=verb==='GET'&&(body===null||body===undefined);
    const key=cacheKey(serverId,verb,endpoint);
    const ttl=Math.max(0,Math.min(120000,Number(cacheTtlMs)||0));
    if(reusable&&ttl>0){
        const cached=responseCache.get(key);
        if(cached&&Date.now()-cached.observedAt<=ttl)return cached.value;
    }

    const server=await getServerSecret(serverId);
    if(!server||!server.enabled)throw new Error('Media server is unavailable or disabled');
    const protectedUser=await assertJellyfinAdministratorProtected(server,endpoint,method,timeoutMs);
    const statePreservingBody=mediaProvider.normalizeType(server.media_server_type)==='jellyfin'
        ? jellyfinUserUpdateBody(endpoint,method,protectedUser,body)
        : body;
    const policySafeBody=await managedDevicePolicyBody(serverId,endpoint,method,statePreservingBody,{bypassDevicePolicy});
    const apiPath=mediaProvider.apiPath(server.media_server_type,endpoint);
    const requestBody=mediaProvider.requestBody(server.media_server_type,endpoint,policySafeBody);
    const url=new URL(apiPath,`${server.base_url}/`);
    if(url.origin!==new URL(server.base_url).origin)throw new Error('Media-server API endpoint escaped the configured server origin.');
    let response;
    try{
        response=await outbound.safeFetch(url,{purpose:`${mediaProvider.label(server.media_server_type)} server ${server.name}`,method,timeoutMs,headers:authHeaders(server.apiKey,{jsonBody:requestBody!==null&&requestBody!==undefined,mediaServerType:server.media_server_type}),...(requestBody!==null&&requestBody!==undefined?{body:JSON.stringify(requestBody)}:{})});
    }catch(error){
        throw operationError(server,method,url,timeoutMs,error);
    }
    const text=await response.text();let parsed=null;if(text){try{parsed=JSON.parse(text)}catch{parsed=text}}
    if(!response.ok){
        const path=url.pathname||'/',providerLabel=mediaProvider.label(server.media_server_type);
        const err=new Error(`${providerLabel} ${server.name} ${verb} ${path} returned HTTP ${response.status}`);
        err.status=response.status;err.response=parsed;err.operation={provider:server.media_server_type,method:verb,path,timeoutMs:Number(timeoutMs||10000)};
        err.retryable=response.status===408||response.status===429||response.status>=500;
        throw err;
    }

    if(mediaProvider.needsPostCreatePassword(server.media_server_type,endpoint,policySafeBody)){
        const userId=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed.Id:null;
        if(!userId){
            const error=new Error('Emby user creation succeeded without returning a user ID; bootstrap password could not be applied safely.');
            error.code='EMBY_USER_CREATE_INVALID_RESPONSE';
            throw error;
        }
        try{
            await request(serverId,`/Users/${encodeURIComponent(userId)}/Password`,{method:'POST',body:{Id:String(userId),NewPw:policySafeBody.Password},timeoutMs});
        }catch(passwordError){
            let cleanupError=null;
            try{await request(serverId,`/Users/${encodeURIComponent(userId)}`,{method:'DELETE',timeoutMs});}catch(error){cleanupError=error;}
            const failed=new Error(cleanupError
                ? 'Emby user was created but bootstrap password setup and automatic rollback both failed. Operator attention is required.'
                : 'Emby bootstrap password setup failed; the newly-created remote user was rolled back.');
            failed.code=cleanupError?'EMBY_USER_BOOTSTRAP_ROLLBACK_FAILED':'EMBY_USER_BOOTSTRAP_FAILED';
            failed.cause=passwordError;
            failed.cleanupError=cleanupError;
            failed.remoteUserId=String(userId);
            throw failed;
        }
    }

    const value=mediaProvider.responseBody(server.media_server_type,endpoint,parsed??{});
    if(reusable)responseCache.set(key,{observedAt:Date.now(),value});
    else clearServerCache(serverId);
    return value;
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
        await query(`UPDATE jellyfin_servers SET health_status=CASE WHEN health_status IN('degraded','offline') THEN 'offline' ELSE 'degraded' END,last_health_check=NOW(),updated_at=NOW() WHERE id=$1`,[serverId]);
        return{ok:false,latencyMs:Date.now()-started,error:err.message};
    }
}
module.exports={normalizeBaseUrl,authHeaders,listServers,getServerSecret,request,healthcheckServer,decryptJellyfinKey,operationError,managedDevicePolicyBody,jellyfinUserMutationTarget,jellyfinUserUpdateBody,assertJellyfinAdministratorProtected,mediaProvider};
