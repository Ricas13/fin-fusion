'use strict';

const crypto=require('crypto');
const {query,transaction}=require('../db');
const provisioning=require('../jellyfin/provisioning-core');
const subscriptionState=require('../entitlements/subscription-state');
const registry=require('../jellyfin/registry');
const planServers=require('../jellyfin/plan-servers');
const outbound=require('../security/outbound-url-policy');
const {encryptWithEnv,decryptWithEnv}=require('../security/purpose-crypto');
const foundation=require('./foundation');

const TOKEN_ENV='STREMIO_JELLYFIN_TOKEN_KEY';
const TOKEN_PREFIX='stremio-jf-token';
function serviceType(row){return String(row?.service_type_snapshot||row?.service_type||'jellyfin');}
function streamLimit(row){return Math.max(1,Math.min(50,Number(row?.streams||1)));}
function internalUsername(customerId){return `cf_stremio_${String(customerId).replace(/-/g,'').slice(0,12)}`;}
function randomPassword(){return crypto.randomBytes(32).toString('base64url');}
function jellyfinAuthHeader(token){if(/[\r\n]/.test(String(token||'')))throw new Error('Invalid Jellyfin user token');return `MediaBrowser Token="${token}"`;}
function clientAuthorization(){return 'MediaBrowser Client="CAPTAiNFiN Stremio", Device="CAPTAiNFiN", DeviceId="captainfin-stremio", Version="1.0"';}

async function entitledSubscription(customerId){
  const addons=await subscriptionState.effectiveAddons(customerId),addon=addons.find(row=>['stremio','bundle'].includes(serviceType(row)));if(addon)return addon;
  const primary=await provisioning.currentEntitlement(customerId);return primary&&['stremio','bundle'].includes(serviceType(primary))?primary:null;
}
async function explicitSourceCount(subscriptionId,{readyOnly=false}={}){
  const conditions=readyOnly?`AND src.enabled=TRUE AND src.auth_state='connected' AND idx.status='ready' AND idx.item_count>0`:'';
  const joins=readyOnly?`JOIN stremio_sources src ON src.id=ps.source_id JOIN stremio_source_index_state idx ON idx.source_id=src.id`:'';
  const r=await query(`SELECT COUNT(*)::int n FROM subscriptions s JOIN plan_stremio_sources ps ON ps.plan_id=s.plan_id AND ps.enabled=TRUE ${joins} WHERE s.id=$1 ${conditions}`,[subscriptionId]);return Number(r.rows[0]?.n||0);
}
async function usesSharedSources(subscriptionId){return(await explicitSourceCount(subscriptionId))>0;}

async function selectServer(plan){
  const servers=(await planServers.eligibleServersForPlan(plan,{enabledOnly:true,forPlacement:true})).filter(server=>server.stremio_enabled===true&&server.allow_new_users!==false&&server.public_url);
  if(!servers.length)throw new Error('No healthy Stremio-enabled Jellyfin server with a public URL is available for this plan.');return servers[0];
}
async function authenticateRestrictedUser(serverId,username,password){
  const server=await registry.getServerSecret(serverId);if(!server)throw new Error('Jellyfin server unavailable');
  const url=new URL('/Users/AuthenticateByName',`${server.base_url}/`),response=await outbound.safeFetch(url,{purpose:`Stremio restricted authentication on ${server.name}`,method:'POST',timeoutMs:10000,headers:{Authorization:clientAuthorization(),Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({Username:username,Pw:password})});
  const text=await response.text();let body={};try{body=text?JSON.parse(text):{};}catch{}
  if(!response.ok||!body.AccessToken||!body.User?.Id)throw new Error(`Restricted Jellyfin authentication failed (${response.status}).`);return{accessToken:String(body.AccessToken),userId:String(body.User.Id)};
}
async function logoutRestrictedToken(server,encryptedToken){if(!encryptedToken)return false;try{const token=decryptWithEnv(encryptedToken,TOKEN_ENV,TOKEN_PREFIX),url=new URL('/Sessions/Logout',`${server.base_url}/`),response=await outbound.safeFetch(url,{purpose:`Stremio restricted logout on ${server.name}`,method:'POST',timeoutMs:8000,headers:{Authorization:jellyfinAuthHeader(token),Accept:'application/json'}});return response.ok;}catch(_error){console.warn('Stremio restricted Jellyfin logout failed.');return false;}}
async function refreshRestrictedAccess(account,server,priorEncryptedToken=null){await logoutRestrictedToken(server,priorEncryptedToken);const password=randomPassword();await registry.request(server.id,`/Users/${account.jellyfin_user_id}/Password`,{method:'POST',body:{Id:account.jellyfin_user_id,NewPw:password}});const auth=await authenticateRestrictedUser(server.id,account.jellyfin_username,password);if(auth.userId!==String(account.jellyfin_user_id))throw new Error('Restricted Jellyfin authentication returned the wrong user identity.');await query(`UPDATE jellyfin_accounts SET password_setup_required=FALSE,updated_at=NOW() WHERE id=$1`,[account.id]);return{encryptedToken:encryptWithEnv(auth.accessToken,TOKEN_ENV,TOKEN_PREFIX),issuedAt:new Date()};}
async function setInternalPolicy(account,plan,effective,limit,disabled=false){const access=await provisioning.resolveLibraryAccessForServer(account.server_id,effective.unrestricted,effective.visibleNames,disabled),body={...provisioning.policyBody(effective.technical,disabled,access),EnableRemoteAccess:!disabled,MaxActiveSessions:disabled?0:limit,EnableContentDownloading:false,EnableSyncTranscoding:false,EnableMediaConversion:false,EnableLiveTvManagement:false,EnableUserPreferenceAccess:false};await registry.request(account.server_id,`/Users/${account.jellyfin_user_id}/Policy`,{method:'POST',body});return access;}
async function findInternalAccount(customerId,serverId){const r=await query(`SELECT * FROM jellyfin_accounts WHERE customer_id=$1 AND server_id=$2 AND account_purpose='stremio_internal' ORDER BY created_at LIMIT 1`,[customerId,serverId]);return r.rows[0]||null;}
async function prepareInternalAccount(customerId,plan,limit,{forceTokenRefresh=false}={}){
  const server=await selectServer(plan),effective=await provisioning.effectivePolicyForCustomer(customerId,plan);let account=await findInternalAccount(customerId,server.id),encryptedToken=null,issuedAt=null,priorEncryptedToken=null;
  if(!account){const password=randomPassword();account=await provisioning.createJellyfinAccount(customerId,server,effective,{preferredUsername:internalUsername(customerId),bootstrapPassword:password,makePrimary:false});await query(`UPDATE jellyfin_accounts SET account_purpose='stremio_internal',is_primary=FALSE,password_setup_required=FALSE,updated_at=NOW() WHERE id=$1`,[account.id]);account.account_purpose='stremio_internal';await setInternalPolicy(account,plan,effective,limit,false);const auth=await authenticateRestrictedUser(server.id,account.jellyfin_username,password);if(auth.userId!==String(account.jellyfin_user_id))throw new Error('Restricted Jellyfin authentication returned the wrong user identity.');encryptedToken=encryptWithEnv(auth.accessToken,TOKEN_ENV,TOKEN_PREFIX);issuedAt=new Date();}
  else{const current=await query(`SELECT jellyfin_access_token_encrypted FROM stremio_entitlements WHERE jellyfin_account_id=$1 ORDER BY updated_at DESC LIMIT 1`,[account.id]);priorEncryptedToken=current.rows[0]?.jellyfin_access_token_encrypted||null;await setInternalPolicy(account,plan,effective,limit,false);await query(`UPDATE jellyfin_accounts SET disabled=FALSE,is_primary=FALSE,password_setup_required=FALSE,updated_at=NOW() WHERE id=$1`,[account.id]);if(forceTokenRefresh||!priorEncryptedToken){const rotated=await refreshRestrictedAccess(account,server,priorEncryptedToken);encryptedToken=rotated.encryptedToken;issuedAt=rotated.issuedAt;}}
  return{server,account,encryptedToken,issuedAt};
}

async function reconcileSharedForCustomer(customerId,sub){
  const mapped=await explicitSourceCount(sub.subscription_id);if(!mapped)return null;const ready=await explicitSourceCount(sub.subscription_id,{readyOnly:true});if(!ready)throw new Error('No selected Stremio source is currently ready. Check Servers → Stremio Sources.');
  const limit=streamLimit(sub),existing=await query(`SELECT * FROM stremio_entitlements WHERE subscription_id=$1`,[sub.subscription_id]),prior=existing.rows[0]||null;
  await transaction(async client=>{if(prior){if(prior.jellyfin_account_id){const managed=await client.query(`SELECT * FROM jellyfin_accounts WHERE id=$1 AND account_purpose='stremio_internal'`,[prior.jellyfin_account_id]);if(managed.rowCount)provisioning.disableJellyfinAccount(managed.rows[0]).catch(()=>{});}await client.query(`UPDATE stremio_entitlements SET customer_id=$2,server_id=NULL,jellyfin_account_id=NULL,stream_limit=$3,jellyfin_access_token_encrypted=NULL,jellyfin_token_issued_at=NULL,status=CASE WHEN status='revoked' THEN 'revoked' WHEN token_hash IS NULL THEN 'pending' ELSE 'active' END,last_error=NULL,updated_at=NOW() WHERE id=$1`,[prior.id,customerId,limit]);}else await client.query(`INSERT INTO stremio_entitlements(customer_id,subscription_id,status,stream_limit) VALUES($1,$2,'pending',$3)`,[customerId,sub.subscription_id,limit]);});
  const refreshed=await query(`SELECT status,token_hash FROM stremio_entitlements WHERE subscription_id=$1`,[sub.subscription_id]),row=refreshed.rows[0]||{};return{active:row.status==='active'&&Boolean(row.token_hash),status:row.status||'pending',serverId:null,accountId:null,subscriptionId:sub.subscription_id,isAddon:Boolean(sub.is_addon),sharedSources:true};
}
async function reconcileForCustomer(customerId,entitlement=null,{forceTokenRefresh=false}={}){
  const sub=entitlement||await entitledSubscription(customerId);if(!sub||!['stremio','bundle'].includes(serviceType(sub)))return suspend(customerId,'Stremio service is not currently entitled.');
  const shared=await reconcileSharedForCustomer(customerId,sub);if(shared)return shared;
  const limit=streamLimit(sub),prepared=await prepareInternalAccount(customerId,sub,limit,{forceTokenRefresh}),existing=await query(`SELECT * FROM stremio_entitlements WHERE subscription_id=$1`,[sub.subscription_id]),prior=existing.rows[0]||null;
  await transaction(async client=>{if(prior)await client.query(`UPDATE stremio_entitlements SET customer_id=$2,server_id=$3,jellyfin_account_id=$4,stream_limit=$5,jellyfin_access_token_encrypted=COALESCE($6,jellyfin_access_token_encrypted),jellyfin_token_issued_at=COALESCE($7,jellyfin_token_issued_at),status=CASE WHEN status='revoked' THEN 'revoked' WHEN token_hash IS NULL THEN 'pending' ELSE 'active' END,last_error=NULL,updated_at=NOW() WHERE id=$1`,[prior.id,customerId,prepared.server.id,prepared.account.id,limit,prepared.encryptedToken,prepared.issuedAt]);else await client.query(`INSERT INTO stremio_entitlements(customer_id,subscription_id,server_id,jellyfin_account_id,status,stream_limit,jellyfin_access_token_encrypted,jellyfin_token_issued_at) VALUES($1,$2,$3,$4,'pending',$5,$6,$7)`,[customerId,sub.subscription_id,prepared.server.id,prepared.account.id,limit,prepared.encryptedToken,prepared.issuedAt]);});
  const refreshed=await query(`SELECT status,token_hash FROM stremio_entitlements WHERE subscription_id=$1`,[sub.subscription_id]),row=refreshed.rows[0]||{};return{active:row.status==='active'&&Boolean(row.token_hash),status:row.status||'pending',serverId:prepared.server.id,accountId:prepared.account.id,subscriptionId:sub.subscription_id,isAddon:Boolean(sub.is_addon),sharedSources:false};
}
async function current(customerId){const r=await query(`SELECT e.*,s.status subscription_status,s.current_period_end,s.service_type_snapshot,p.service_type,p.streams,p.name plan_name,p.code plan_code,p.is_addon FROM stremio_entitlements e JOIN subscriptions s ON s.id=e.subscription_id JOIN plans p ON p.id=s.plan_id WHERE e.customer_id=$1 ORDER BY e.created_at DESC LIMIT 1`,[customerId]);return r.rows[0]||null;}
async function suspend(customerId,reason='No active Stremio entitlement'){const rows=await query(`UPDATE stremio_entitlements SET status=CASE WHEN status='revoked' THEN status ELSE 'suspended' END,last_error=$2,updated_at=NOW() WHERE customer_id=$1 RETURNING jellyfin_account_id`,[customerId,String(reason).slice(0,1000)]);for(const row of rows.rows){if(!row.jellyfin_account_id)continue;const a=await query(`SELECT * FROM jellyfin_accounts WHERE id=$1 AND account_purpose='stremio_internal'`,[row.jellyfin_account_id]);if(a.rowCount){try{await provisioning.disableJellyfinAccount(a.rows[0]);}catch(_error){console.warn('Unable to disable a Stremio internal Jellyfin account.');}}}return{active:false,status:'suspended'};}

async function issueInstallation(customerId){
  foundation.assertAcquirable({service_type:'stremio'});const sub=await entitledSubscription(customerId);if(!sub)throw new Error('Your current plan or add-on does not include Stremio.');
  const shared=await usesSharedSources(sub.subscription_id);await reconcileForCustomer(customerId,sub,{forceTokenRefresh:!shared});
  const issued=foundation.issueInstallCredential(),r=await query(`UPDATE stremio_entitlements SET token_hash=$2,token_hint=$3,token_version=token_version+1,status='active',install_issued_at=NOW(),revoked_at=NULL,last_error=NULL,updated_at=NOW() WHERE subscription_id=$1 AND ($4::boolean OR jellyfin_access_token_encrypted IS NOT NULL) RETURNING *`,[sub.subscription_id,issued.hash,issued.hint,shared]);
  if(!r.rowCount)throw new Error('Stremio entitlement could not be activated.');return{credential:issued.token,entitlement:r.rows[0]};
}
async function revoke(customerId){
  const rows=await transaction(async client=>{const selected=await client.query(`SELECT e.id,e.jellyfin_account_id,e.jellyfin_access_token_encrypted,js.id server_id,js.name server_name,js.base_url FROM stremio_entitlements e LEFT JOIN jellyfin_servers js ON js.id=e.server_id WHERE e.customer_id=$1 AND e.status<>'revoked' FOR UPDATE OF e`,[customerId]);if(selected.rowCount)await client.query(`UPDATE stremio_entitlements SET status='revoked',token_hash=NULL,token_hint=NULL,revoked_at=NOW(),updated_at=NOW() WHERE customer_id=$1 AND status<>'revoked'`,[customerId]);return selected.rows;});
  for(const row of rows){const server=row.server_id?{id:row.server_id,name:row.server_name,base_url:row.base_url}:null;if(server)await logoutRestrictedToken(server,row.jellyfin_access_token_encrypted);if(row.jellyfin_account_id){const a=await query(`SELECT * FROM jellyfin_accounts WHERE id=$1 AND account_purpose='stremio_internal'`,[row.jellyfin_account_id]);if(a.rowCount)await provisioning.disableJellyfinAccount(a.rows[0]).catch(()=>{});}await query(`UPDATE stremio_entitlements SET jellyfin_access_token_encrypted=NULL,jellyfin_token_issued_at=NULL,updated_at=NOW() WHERE id=$1`,[row.id]);}return rows.length;
}
async function findByInstallToken(raw){
  const token=String(raw||'');if(token.length<32)return null;const hash=foundation.hashInstallCredential(token);
  const r=await query(`WITH effective AS (SELECT customer_id,subscription_id,access_expires_at,blocked FROM effective_customer_entitlements UNION ALL SELECT customer_id,subscription_id,access_expires_at,blocked FROM effective_customer_addons)
    SELECT e.*,s.plan_id,s.status subscription_status,s.current_period_end,s.service_type_snapshot,p.service_type,p.streams,p.name plan_name,p.is_addon,ee.access_expires_at,ee.blocked,
      ja.jellyfin_user_id,ja.jellyfin_username,ja.disabled account_disabled,js.base_url,js.public_url,js.name server_name,js.enabled server_enabled,js.stremio_enabled,
      EXISTS(SELECT 1 FROM plan_stremio_sources ps WHERE ps.plan_id=s.plan_id AND ps.enabled=TRUE) has_shared_sources
    FROM stremio_entitlements e JOIN effective ee ON ee.customer_id=e.customer_id AND ee.subscription_id=e.subscription_id JOIN subscriptions s ON s.id=e.subscription_id JOIN plans p ON p.id=s.plan_id LEFT JOIN jellyfin_accounts ja ON ja.id=e.jellyfin_account_id LEFT JOIN jellyfin_servers js ON js.id=e.server_id
    WHERE e.token_hash=$1 AND e.status='active' AND ee.blocked=FALSE AND ee.access_expires_at>NOW() LIMIT 1`,[hash]);
  const row=r.rows[0]||null;if(!row||!['stremio','bundle'].includes(serviceType(row)))return null;
  if(row.has_shared_sources)return row;
  if(!row.jellyfin_user_id||row.account_disabled||!row.server_enabled||!row.stremio_enabled)return null;return row;
}
function accessToken(entitlement){return entitlement?.jellyfin_access_token_encrypted?decryptWithEnv(entitlement.jellyfin_access_token_encrypted,TOKEN_ENV,TOKEN_PREFIX):null;}
async function markUse(id,kind){if(kind==='manifest')return query(`UPDATE stremio_entitlements SET last_manifest_at=NOW(),last_used_at=NOW(),updated_at=NOW() WHERE id=$1`,[id]);return query(`UPDATE stremio_entitlements SET last_stream_request_at=NOW(),last_used_at=NOW(),updated_at=NOW() WHERE id=$1`,[id]);}

module.exports={TOKEN_ENV,TOKEN_PREFIX,serviceType,streamLimit,jellyfinAuthHeader,clientAuthorization,entitledSubscription,explicitSourceCount,usesSharedSources,selectServer,authenticateRestrictedUser,logoutRestrictedToken,refreshRestrictedAccess,reconcileForCustomer,reconcileSharedForCustomer,issueInstallation,revoke,current,findByInstallToken,accessToken,markUse,suspend};