'use strict';

const crypto=require('crypto');
const {query,transaction}=require('../db');
const provisioning=require('../jellyfin/provisioning');
const subscriptionState=require('../entitlements/subscription-state');
const registry=require('../jellyfin/registry');
const planServers=require('../jellyfin/plan-servers');
const outbound=require('../security/outbound-url-policy');
const {encryptWithEnv,decryptWithEnv}=require('../security/purpose-crypto');
const foundation=require('./foundation');
const operationLock=require('./operation-lock');
const installRecovery=require('./install-credential-recovery');

const TOKEN_ENV='STREMIO_JELLYFIN_TOKEN_KEY';
const TOKEN_PREFIX='stremio-jf-token';
const INSTALL_CONCURRENCY_WINDOW_MS=5000;
function serviceType(row){return String(row?.service_type_snapshot||row?.service_type||'jellyfin');}
function streamLimit(_row){return 1;}
function randomPassword(){return crypto.randomBytes(32).toString('base64url');}
function jellyfinAuthHeader(token){if(/[\r\n]/.test(String(token||'')))throw new Error('Invalid Jellyfin user token');return `MediaBrowser Token="${token}"`;}
function clientAuthorization(type='jellyfin',userId=''){return registry.mediaProvider.clientAuthorization(type,{userId});}
function restrictedTokenHeaders(type,token,{jsonBody=false}={}){return registry.mediaProvider.userTokenHeaders(type,token,{jsonBody});}

async function entitledSubscription(customerId){const addons=await subscriptionState.effectiveAddons(customerId),addon=addons.find(row=>['stremio','bundle'].includes(serviceType(row)));if(addon)return addon;return subscriptionState.effectiveStremioSubscription(customerId);}
async function explicitSourceCount(subscriptionId,{readyOnly=false}={}){const conditions=readyOnly?`AND src.enabled=TRUE AND src.auth_state='connected' AND idx.status='ready' AND idx.item_count>0`:'',joins=readyOnly?`JOIN stremio_sources src ON src.id=ps.source_id JOIN stremio_source_index_state idx ON idx.source_id=src.id`:'';const r=await query(`SELECT COUNT(*)::int n FROM subscriptions s JOIN plan_stremio_sources ps ON ps.plan_id=s.plan_id AND ps.enabled=TRUE ${joins} WHERE s.id=$1 ${conditions}`,[subscriptionId]);return Number(r.rows[0]?.n||0);}
async function usesSharedSources(subscriptionId){return(await explicitSourceCount(subscriptionId))>0;}

async function selectServer(plan){const servers=(await planServers.eligibleServersForPlan(plan,{enabledOnly:true,forPlacement:true})).filter(server=>server.stremio_enabled===true&&server.allow_new_users!==false&&server.public_url);if(!servers.length)throw new Error('No healthy Stremio-enabled media server with a public URL is available for this plan.');return servers[0];}
async function authenticateRestrictedUser(serverId,username,password){
  const server=await registry.getServerSecret(serverId);if(!server)throw new Error('Media server unavailable');
  const type=registry.mediaProvider.normalizeType(server.media_server_type),providerLabel=registry.mediaProvider.label(type),url=registry.mediaProvider.apiUrl(server.base_url,type,'/Users/AuthenticateByName');
  const response=await outbound.safeFetch(url,{purpose:`Stremio restricted authentication on ${server.name}`,method:'POST',timeoutMs:10000,headers:{Authorization:clientAuthorization(type),Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({Username:username,Pw:password})});
  const text=await response.text();let body={};try{body=text?JSON.parse(text):{};}catch{}
  if(!response.ok||!body.AccessToken||!body.User?.Id)throw new Error(`Restricted ${providerLabel} authentication failed (${response.status}).`);
  return{accessToken:String(body.AccessToken),userId:String(body.User.Id),mediaServerType:type};
}
async function logoutRestrictedToken(server,encryptedToken){if(!encryptedToken)return false;try{const type=registry.mediaProvider.normalizeType(server?.media_server_type),token=decryptWithEnv(encryptedToken,TOKEN_ENV,TOKEN_PREFIX),url=registry.mediaProvider.apiUrl(server.base_url,type,'/Sessions/Logout'),response=await outbound.safeFetch(url,{purpose:`Stremio restricted logout on ${server.name}`,method:'POST',timeoutMs:8000,headers:restrictedTokenHeaders(type,token)});return response.ok||response.status===401||response.status===403;}catch(_error){console.warn('Stremio restricted media-server logout failed.');return false;}}
async function refreshRestrictedAccess(account,server,priorEncryptedToken=null){if(priorEncryptedToken){const loggedOut=await logoutRestrictedToken(server,priorEncryptedToken);if(!loggedOut)throw new Error('Could not verify revocation of the previous restricted Stremio token.');}const password=randomPassword();await registry.request(server.id,`/Users/${account.jellyfin_user_id}/Password`,{method:'POST',body:{Id:account.jellyfin_user_id,NewPw:password}});const auth=await authenticateRestrictedUser(server.id,account.jellyfin_username,password);if(auth.userId!==String(account.jellyfin_user_id))throw new Error('Restricted media-server authentication returned the wrong user identity.');await query(`UPDATE jellyfin_accounts SET password_setup_required=FALSE,updated_at=NOW() WHERE id=$1`,[account.id]);return{encryptedToken:encryptWithEnv(auth.accessToken,TOKEN_ENV,TOKEN_PREFIX),issuedAt:new Date(),mediaServerType:auth.mediaServerType};}

async function managedAccountOwned(accountId){if(!accountId)return false;const r=await query(`SELECT EXISTS(SELECT 1 FROM stremio_managed_accounts WHERE jellyfin_account_id=$1 AND status='active') yes`,[accountId]);return r.rows[0]?.yes===true;}
async function disableLegacyAccountIfUnowned(accountId){if(!accountId||await managedAccountOwned(accountId))return false;const a=await query(`SELECT * FROM jellyfin_accounts WHERE id=$1 AND account_purpose='stremio_internal'`,[accountId]);if(!a.rowCount)return false;await provisioning.disableJellyfinAccount(a.rows[0]);return true;}
async function detachLegacyToken(row){if(!row?.jellyfin_access_token_encrypted||!row?.server_id||!row?.base_url)return false;return logoutRestrictedToken({id:row.server_id,name:row.server_name,base_url:row.base_url,media_server_type:row.media_server_type},row.jellyfin_access_token_encrypted);}
async function persistEntitlementRecord(customerId,sub,{sharedSources=false}={}){
  const limit=streamLimit(sub),existing=await query(`SELECT e.*,js.name server_name,js.base_url,js.media_server_type FROM stremio_entitlements e LEFT JOIN jellyfin_servers js ON js.id=e.server_id WHERE e.subscription_id=$1`,[sub.subscription_id]),prior=existing.rows[0]||null;
  if(prior?.jellyfin_access_token_encrypted){const retired=await detachLegacyToken(prior);if(!retired)throw new Error('Could not verify revocation of the previous legacy Stremio token. The existing cleanup identity was preserved for retry.');}
  await transaction(async client=>{if(prior)await client.query(`UPDATE stremio_entitlements SET customer_id=$2,server_id=NULL,jellyfin_account_id=NULL,stream_limit=$3,jellyfin_access_token_encrypted=NULL,jellyfin_token_issued_at=NULL,status=CASE WHEN status='revoked' THEN 'revoked' WHEN token_hash IS NULL THEN 'pending' ELSE 'active' END,last_error=NULL,updated_at=NOW() WHERE id=$1`,[prior.id,customerId,limit]);else await client.query(`INSERT INTO stremio_entitlements(customer_id,subscription_id,status,stream_limit) VALUES($1,$2,'pending',$3)`,[customerId,sub.subscription_id,limit]);});
  const refreshed=await query(`SELECT status,token_hash FROM stremio_entitlements WHERE subscription_id=$1`,[sub.subscription_id]),row=refreshed.rows[0]||{};return{active:row.status==='active'&&Boolean(row.token_hash),status:row.status||'pending',serverId:null,accountId:null,subscriptionId:sub.subscription_id,isAddon:Boolean(sub.is_addon),sharedSources:Boolean(sharedSources)};
}
async function reconcileSharedForCustomer(customerId,sub){const mapped=await explicitSourceCount(sub.subscription_id);if(!mapped)return null;const ready=await explicitSourceCount(sub.subscription_id,{readyOnly:true});if(!ready)throw new Error('No selected Stremio source is currently ready. Check Servers → Stremio Sources.');return persistEntitlementRecord(customerId,sub,{sharedSources:true});}
async function reconcileForCustomer(customerId,entitlement=null,_options={}){const sub=entitlement||await entitledSubscription(customerId);if(!sub||!['stremio','bundle'].includes(serviceType(sub)))return suspend(customerId,'Stremio service is not currently entitled.');const shared=await reconcileSharedForCustomer(customerId,sub);if(shared)return shared;return persistEntitlementRecord(customerId,sub,{sharedSources:false});}
async function current(customerId){const r=await query(`SELECT e.*,s.plan_id,s.status subscription_status,s.current_period_end,s.service_type_snapshot,p.service_type,p.streams,p.name plan_name,p.code plan_code,p.is_addon FROM stremio_entitlements e JOIN subscriptions s ON s.id=e.subscription_id JOIN plans p ON p.id=s.plan_id WHERE e.customer_id=$1 ORDER BY e.created_at DESC LIMIT 1`,[customerId]);return r.rows[0]||null;}
async function suspend(customerId,reason='No active Stremio entitlement'){const rows=await query(`SELECT e.id,e.jellyfin_account_id,e.jellyfin_access_token_encrypted,js.id server_id,js.name server_name,js.base_url,js.media_server_type FROM stremio_entitlements e LEFT JOIN jellyfin_servers js ON js.id=e.server_id WHERE e.customer_id=$1`,[customerId]);for(const row of rows.rows){if(row.jellyfin_access_token_encrypted){const retired=await detachLegacyToken(row);if(!retired)throw new Error('Could not verify revocation of legacy Stremio access; suspension will retry.');}await disableLegacyAccountIfUnowned(row.jellyfin_account_id);}await query(`UPDATE stremio_entitlements SET status=CASE WHEN status='revoked' THEN status ELSE 'suspended' END,server_id=NULL,jellyfin_account_id=NULL,jellyfin_access_token_encrypted=NULL,jellyfin_token_issued_at=NULL,last_error=$2,updated_at=NOW() WHERE customer_id=$1`,[customerId,String(reason).slice(0,1000)]);return{active:false,status:'suspended'};}
async function issueInstallation(customerId,{actorUserId=null}={}){return operationLock.withLock(`install-credential:${customerId}`,async()=>{const recent=await installRecovery.current(customerId).catch(()=>null),recentAt=recent?.updated_at?new Date(recent.updated_at).getTime():0;if(recent?.credential&&Number.isFinite(recentAt)&&Date.now()-recentAt<=INSTALL_CONCURRENCY_WINDOW_MS)return{credential:recent.credential,entitlement:{id:recent.entitlement_id,token_version:recent.token_version,token_hint:recent.token_hint},reused:true};foundation.assertAcquirable({service_type:'stremio'});const sub=await entitledSubscription(customerId);if(!sub)throw new Error('Your current plan or add-on does not include Stremio.');await reconcileForCustomer(customerId,sub);const issued=foundation.issueInstallCredential();const entitlement=await transaction(async client=>{const r=await client.query(`UPDATE stremio_entitlements SET token_hash=$2,token_hint=$3,token_version=token_version+1,status='active',install_issued_at=NOW(),revoked_at=NULL,last_error=NULL,updated_at=NOW() WHERE subscription_id=$1 RETURNING *`,[sub.subscription_id,issued.hash,issued.hint]);if(!r.rowCount)throw new Error('Stremio entitlement could not be activated.');await installRecovery.save({customerId,entitlement:r.rows[0],credential:issued.token,actorUserId},{client});return r.rows[0];});return{credential:issued.token,entitlement,reused:false};});}
async function revoke(customerId){return operationLock.withLock(`install-credential:${customerId}`,async()=>{
  const rows=await transaction(async client=>{
    const selected=await client.query(`SELECT e.id,e.jellyfin_account_id,e.jellyfin_access_token_encrypted,js.id server_id,js.name server_name,js.base_url,js.media_server_type FROM stremio_entitlements e LEFT JOIN jellyfin_servers js ON js.id=e.server_id WHERE e.customer_id=$1 AND e.status<>'revoked' FOR UPDATE OF e`,[customerId]);
    if(selected.rowCount)await client.query(`UPDATE stremio_entitlements SET status='suspended',token_hash=NULL,token_hint=NULL,revoked_at=NULL,last_error='Stremio revocation cleanup pending.',updated_at=NOW() WHERE customer_id=$1 AND status<>'revoked'`,[customerId]);
    return selected.rows;
  });
  for(const row of rows){
    try{
      if(row.jellyfin_access_token_encrypted){const retired=await detachLegacyToken(row);if(!retired)throw new Error('Could not verify revocation of legacy Stremio access; revoke will retry without discarding cleanup identity.');}
      await disableLegacyAccountIfUnowned(row.jellyfin_account_id);
    }catch(error){await query(`UPDATE stremio_entitlements SET last_error=$2,updated_at=NOW() WHERE id=$1`,[row.id,String(error?.message||error).slice(0,1000)]).catch(()=>{});throw error;}
  }
  if(rows.length)await transaction(async client=>{await client.query(`UPDATE stremio_entitlements SET status='revoked',server_id=NULL,jellyfin_account_id=NULL,jellyfin_access_token_encrypted=NULL,jellyfin_token_issued_at=NULL,revoked_at=NOW(),last_error=NULL,updated_at=NOW() WHERE customer_id=$1 AND status<>'revoked'`,[customerId]);});
  await installRecovery.clear(customerId).catch(()=>{});
  return rows.length;
});}
async function findByInstallToken(raw){const token=String(raw||'');if(token.length<32)return null;const hash=foundation.hashInstallCredential(token),r=await query(`WITH effective AS (
      SELECT customer_id,subscription_id,access_expires_at,blocked FROM effective_stremio_entitlements
      UNION ALL
      SELECT a.customer_id,a.subscription_id,a.access_expires_at,public.subscription_access_blocked(s.customer_id,s.source,s.provider_subscription_id) AS blocked
      FROM effective_customer_addons a JOIN subscriptions s ON s.id=a.subscription_id
    )
    SELECT e.*,s.plan_id,s.status subscription_status,s.current_period_end,s.service_type_snapshot,p.service_type,p.streams,p.name plan_name,p.is_addon,ee.access_expires_at,ee.blocked,
      ja.jellyfin_user_id,ja.jellyfin_username,ja.disabled account_disabled,js.base_url,js.public_url,js.name server_name,js.media_server_type,js.enabled server_enabled,js.stremio_enabled,
      EXISTS(SELECT 1 FROM plan_stremio_sources ps WHERE ps.plan_id=s.plan_id AND ps.enabled=TRUE) has_shared_sources
    FROM stremio_entitlements e JOIN effective ee ON ee.customer_id=e.customer_id AND ee.subscription_id=e.subscription_id JOIN subscriptions s ON s.id=e.subscription_id JOIN plans p ON p.id=s.plan_id LEFT JOIN jellyfin_accounts ja ON ja.id=e.jellyfin_account_id LEFT JOIN jellyfin_servers js ON js.id=e.server_id
    WHERE e.token_hash=$1 AND e.status='active' AND ee.blocked=FALSE AND ee.access_expires_at>NOW() LIMIT 1`,[hash]),row=r.rows[0]||null;if(!row||!['stremio','bundle'].includes(serviceType(row)))return null;return row;}
function accessToken(entitlement){return entitlement?.jellyfin_access_token_encrypted?decryptWithEnv(entitlement.jellyfin_access_token_encrypted,TOKEN_ENV,TOKEN_PREFIX):null;}
async function markUse(id,kind){if(kind==='manifest')return query(`UPDATE stremio_entitlements SET last_manifest_at=NOW(),last_used_at=NOW(),updated_at=NOW() WHERE id=$1`,[id]);return query(`UPDATE stremio_entitlements SET last_stream_request_at=NOW(),last_used_at=NOW(),updated_at=NOW() WHERE id=$1`,[id]);}

module.exports={TOKEN_ENV,TOKEN_PREFIX,INSTALL_CONCURRENCY_WINDOW_MS,serviceType,streamLimit,jellyfinAuthHeader,clientAuthorization,restrictedTokenHeaders,entitledSubscription,explicitSourceCount,usesSharedSources,selectServer,authenticateRestrictedUser,logoutRestrictedToken,refreshRestrictedAccess,reconcileForCustomer,reconcileSharedForCustomer,issueInstallation,revoke,current,findByInstallToken,accessToken,markUse,suspend};
