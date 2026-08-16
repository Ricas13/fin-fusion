'use strict';

const crypto=require('crypto');
const {query,transaction}=require('../db');
const provisioning=require('../jellyfin/provisioning-core');
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
function clientAuthorization(){return 'MediaBrowser Client="CAPTaINFiN Stremio", Device="CAPTaINFiN", DeviceId="captainfin-stremio", Version="1.0"';}

async function selectServer(plan){
  const servers=(await planServers.eligibleServersForPlan(plan,{enabledOnly:true,forPlacement:true}))
    .filter(server=>server.stremio_enabled===true&&server.allow_new_users!==false&&server.public_url);
  if(!servers.length)throw new Error('No healthy Stremio-enabled Jellyfin server with a public URL is available for this plan.');
  return servers[0];
}

async function authenticateRestrictedUser(serverId,username,password){
  const server=await registry.getServerSecret(serverId);if(!server)throw new Error('Jellyfin server unavailable');
  const url=new URL('/Users/AuthenticateByName',`${server.base_url}/`);
  const response=await outbound.safeFetch(url,{purpose:`Stremio restricted authentication on ${server.name}`,method:'POST',timeoutMs:10000,headers:{Authorization:clientAuthorization(),Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({Username:username,Pw:password})});
  const text=await response.text();let body={};try{body=text?JSON.parse(text):{};}catch{}
  if(!response.ok||!body.AccessToken||!body.User?.Id)throw new Error(`Restricted Jellyfin authentication failed (${response.status}).`);
  return{accessToken:String(body.AccessToken),userId:String(body.User.Id)};
}

async function logoutRestrictedToken(server,encryptedToken){
  if(!encryptedToken)return false;
  try{
    const token=decryptWithEnv(encryptedToken,TOKEN_ENV,TOKEN_PREFIX),url=new URL('/Sessions/Logout',`${server.base_url}/`);
    const response=await outbound.safeFetch(url,{purpose:`Stremio restricted logout on ${server.name}`,method:'POST',timeoutMs:8000,headers:{Authorization:jellyfinAuthHeader(token),Accept:'application/json'}});
    return response.ok;
  }catch(_error){console.warn('Stremio restricted Jellyfin logout failed.');return false;}
}

async function refreshRestrictedAccess(account,server,priorEncryptedToken=null){
  await logoutRestrictedToken(server,priorEncryptedToken);
  const password=randomPassword();
  await registry.request(server.id,`/Users/${account.jellyfin_user_id}/Password`,{method:'POST',body:{Id:account.jellyfin_user_id,NewPw:password}});
  const auth=await authenticateRestrictedUser(server.id,account.jellyfin_username,password);
  if(auth.userId!==String(account.jellyfin_user_id))throw new Error('Restricted Jellyfin authentication returned the wrong user identity.');
  await query(`UPDATE jellyfin_accounts SET password_setup_required=FALSE,updated_at=NOW() WHERE id=$1`,[account.id]);
  return{encryptedToken:encryptWithEnv(auth.accessToken,TOKEN_ENV,TOKEN_PREFIX),issuedAt:new Date()};
}

async function setInternalPolicy(account,plan,effective,limit,disabled=false){
  const access=await provisioning.resolveLibraryAccessForServer(account.server_id,effective.unrestricted,effective.visibleNames,disabled);
  const body={...provisioning.policyBody(effective.technical,disabled,access),
    MaxActiveSessions:disabled?0:limit,
    EnableContentDownloading:false,
    EnableSyncTranscoding:false,
    EnableMediaConversion:false,
    EnableLiveTvManagement:false,
    EnableUserPreferenceAccess:false
  };
  await registry.request(account.server_id,`/Users/${account.jellyfin_user_id}/Policy`,{method:'POST',body});
  return access;
}

async function findInternalAccount(customerId,serverId){
  const r=await query(`SELECT * FROM jellyfin_accounts WHERE customer_id=$1 AND server_id=$2 AND account_purpose='stremio_internal' ORDER BY created_at LIMIT 1`,[customerId,serverId]);
  return r.rows[0]||null;
}

async function prepareInternalAccount(customerId,plan,limit,{forceTokenRefresh=false}={}){
  const server=await selectServer(plan),effective=await provisioning.effectivePolicyForCustomer(customerId,plan);
  let account=await findInternalAccount(customerId,server.id),encryptedToken=null,issuedAt=null,priorEncryptedToken=null;
  if(!account){
    const password=randomPassword();
    account=await provisioning.createJellyfinAccount(customerId,server,effective,{preferredUsername:internalUsername(customerId),bootstrapPassword:password,makePrimary:false});
    await query(`UPDATE jellyfin_accounts SET account_purpose='stremio_internal',is_primary=FALSE,password_setup_required=FALSE,updated_at=NOW() WHERE id=$1`,[account.id]);
    account.account_purpose='stremio_internal';
    await setInternalPolicy(account,plan,effective,limit,false);
    const auth=await authenticateRestrictedUser(server.id,account.jellyfin_username,password);
    if(auth.userId!==String(account.jellyfin_user_id))throw new Error('Restricted Jellyfin authentication returned the wrong user identity.');
    encryptedToken=encryptWithEnv(auth.accessToken,TOKEN_ENV,TOKEN_PREFIX);issuedAt=new Date();
  }else{
    const current=await query(`SELECT jellyfin_access_token_encrypted FROM stremio_entitlements WHERE jellyfin_account_id=$1 ORDER BY updated_at DESC LIMIT 1`,[account.id]);
    priorEncryptedToken=current.rows[0]?.jellyfin_access_token_encrypted||null;
    await setInternalPolicy(account,plan,effective,limit,false);
    await query(`UPDATE jellyfin_accounts SET disabled=FALSE,is_primary=FALSE,password_setup_required=FALSE,updated_at=NOW() WHERE id=$1`,[account.id]);
    if(forceTokenRefresh||!priorEncryptedToken){const rotated=await refreshRestrictedAccess(account,server,priorEncryptedToken);encryptedToken=rotated.encryptedToken;issuedAt=rotated.issuedAt;}
  }
  return{server,account,encryptedToken,issuedAt};
}

async function current(customerId){
  const r=await query(`SELECT e.*,s.status subscription_status,s.current_period_end,s.service_type_snapshot,p.service_type,p.streams,p.name plan_name,p.code plan_code
    FROM stremio_entitlements e JOIN subscriptions s ON s.id=e.subscription_id JOIN plans p ON p.id=s.plan_id
    WHERE e.customer_id=$1 ORDER BY e.created_at DESC LIMIT 1`,[customerId]);
  return r.rows[0]||null;
}

async function suspend(customerId,reason='No active Stremio entitlement'){
  const rows=await query(`UPDATE stremio_entitlements SET status=CASE WHEN status='revoked' THEN status ELSE 'suspended' END,last_error=$2,updated_at=NOW() WHERE customer_id=$1 RETURNING jellyfin_account_id`,[customerId,String(reason).slice(0,1000)]);
  for(const row of rows.rows){if(!row.jellyfin_account_id)continue;const a=await query(`SELECT * FROM jellyfin_accounts WHERE id=$1 AND account_purpose='stremio_internal'`,[row.jellyfin_account_id]);if(a.rowCount){try{await provisioning.disableJellyfinAccount(a.rows[0]);}catch(_error){console.warn('Unable to disable a Stremio internal Jellyfin account.');}}}
  return{active:false,status:'suspended'};
}

async function reconcileForCustomer(customerId,entitlement=null,{forceTokenRefresh=false}={}){
  const sub=entitlement||await provisioning.currentEntitlement(customerId);
  if(!sub||!['stremio','bundle'].includes(serviceType(sub)))return suspend(customerId,'Stremio service is not currently entitled.');
  const limit=streamLimit(sub),prepared=await prepareInternalAccount(customerId,sub,limit,{forceTokenRefresh});
  const existing=await query(`SELECT * FROM stremio_entitlements WHERE subscription_id=$1`,[sub.subscription_id]);
  const prior=existing.rows[0]||null;
  await transaction(async client=>{
    if(prior){
      await client.query(`UPDATE stremio_entitlements SET customer_id=$2,server_id=$3,jellyfin_account_id=$4,stream_limit=$5,
        jellyfin_access_token_encrypted=COALESCE($6,jellyfin_access_token_encrypted),jellyfin_token_issued_at=COALESCE($7,jellyfin_token_issued_at),
        status=CASE WHEN status='revoked' THEN 'revoked' WHEN token_hash IS NULL THEN 'pending' ELSE 'active' END,last_error=NULL,updated_at=NOW() WHERE id=$1`,
        [prior.id,customerId,prepared.server.id,prepared.account.id,limit,prepared.encryptedToken,prepared.issuedAt]);
    }else{
      await client.query(`INSERT INTO stremio_entitlements(customer_id,subscription_id,server_id,jellyfin_account_id,status,stream_limit,jellyfin_access_token_encrypted,jellyfin_token_issued_at)
        VALUES($1,$2,$3,$4,'pending',$5,$6,$7)`,[customerId,sub.subscription_id,prepared.server.id,prepared.account.id,limit,prepared.encryptedToken,prepared.issuedAt]);
    }
  });
  const refreshed=await query(`SELECT status,token_hash FROM stremio_entitlements WHERE subscription_id=$1`,[sub.subscription_id]),row=refreshed.rows[0]||{};
  return{active:row.status==='active'&&Boolean(row.token_hash),status:row.status||'pending',serverId:prepared.server.id,accountId:prepared.account.id};
}

async function issueInstallation(customerId){
  foundation.assertAcquirable({service_type:'stremio'});
  const sub=await provisioning.currentEntitlement(customerId);if(!sub||!['stremio','bundle'].includes(serviceType(sub)))throw new Error('Your current plan does not include Stremio.');
  // Rotating the addon URL also rotates the restricted Jellyfin session token,
  // so a copied old stream response cannot keep a long-lived playback bearer.
  await reconcileForCustomer(customerId,sub,{forceTokenRefresh:true});
  const issued=foundation.issueInstallCredential();
  const r=await query(`UPDATE stremio_entitlements SET token_hash=$2,token_hint=$3,token_version=token_version+1,status='active',install_issued_at=NOW(),revoked_at=NULL,last_error=NULL,updated_at=NOW()
    WHERE subscription_id=$1 AND jellyfin_access_token_encrypted IS NOT NULL RETURNING *`,[sub.subscription_id,issued.hash,issued.hint]);
  if(!r.rowCount)throw new Error('Stremio entitlement could not be activated.');
  return{credential:issued.token,entitlement:r.rows[0]};
}

async function revoke(customerId){
  const rows=await transaction(async client=>{
    const selected=await client.query(`SELECT e.id,e.jellyfin_account_id,e.jellyfin_access_token_encrypted,js.id server_id,js.name server_name,js.base_url
      FROM stremio_entitlements e LEFT JOIN jellyfin_servers js ON js.id=e.server_id
      WHERE e.customer_id=$1 AND e.status<>'revoked' FOR UPDATE OF e`,[customerId]);
    if(selected.rowCount)await client.query(`UPDATE stremio_entitlements SET status='revoked',token_hash=NULL,token_hint=NULL,revoked_at=NOW(),updated_at=NOW() WHERE customer_id=$1 AND status<>'revoked'`,[customerId]);
    return selected.rows;
  });
  for(const row of rows){
    const server=row.server_id?{id:row.server_id,name:row.server_name,base_url:row.base_url}:null;
    if(server)await logoutRestrictedToken(server,row.jellyfin_access_token_encrypted);
    if(row.jellyfin_account_id){const a=await query(`SELECT * FROM jellyfin_accounts WHERE id=$1 AND account_purpose='stremio_internal'`,[row.jellyfin_account_id]);if(a.rowCount)await provisioning.disableJellyfinAccount(a.rows[0]).catch(()=>{});}
    await query(`UPDATE stremio_entitlements SET jellyfin_access_token_encrypted=NULL,jellyfin_token_issued_at=NULL,updated_at=NOW() WHERE id=$1`,[row.id]);
  }
  return rows.length;
}

async function findByInstallToken(raw){
  const token=String(raw||'');if(token.length<32)return null;const hash=foundation.hashInstallCredential(token);
  const r=await query(`SELECT e.*,s.status subscription_status,s.current_period_end,s.service_type_snapshot,p.service_type,p.streams,p.name plan_name,
      ee.access_expires_at,ee.blocked,
      ja.jellyfin_user_id,ja.jellyfin_username,ja.disabled account_disabled,js.base_url,js.public_url,js.name server_name,js.enabled server_enabled,js.stremio_enabled
    FROM stremio_entitlements e
    JOIN effective_customer_entitlements ee ON ee.customer_id=e.customer_id AND ee.subscription_id=e.subscription_id
    JOIN subscriptions s ON s.id=e.subscription_id JOIN plans p ON p.id=s.plan_id
    JOIN jellyfin_accounts ja ON ja.id=e.jellyfin_account_id JOIN jellyfin_servers js ON js.id=e.server_id
    WHERE e.token_hash=$1 AND e.status='active' AND ee.blocked=FALSE AND ee.access_expires_at>NOW()
      AND ja.account_purpose='stremio_internal' LIMIT 1`,[hash]);
  const row=r.rows[0]||null;if(!row)return null;
  if(!['stremio','bundle'].includes(serviceType(row))||row.account_disabled||!row.server_enabled||!row.stremio_enabled)return null;
  return row;
}

function accessToken(entitlement){return decryptWithEnv(entitlement.jellyfin_access_token_encrypted,TOKEN_ENV,TOKEN_PREFIX);}
async function markUse(id,kind){
  if(kind==='manifest')return query(`UPDATE stremio_entitlements SET last_manifest_at=NOW(),last_used_at=NOW(),updated_at=NOW() WHERE id=$1`,[id]);
  return query(`UPDATE stremio_entitlements SET last_stream_request_at=NOW(),last_used_at=NOW(),updated_at=NOW() WHERE id=$1`,[id]);
}

module.exports={TOKEN_ENV,TOKEN_PREFIX,serviceType,streamLimit,jellyfinAuthHeader,clientAuthorization,selectServer,authenticateRestrictedUser,logoutRestrictedToken,refreshRestrictedAccess,reconcileForCustomer,issueInstallation,revoke,current,findByInstallToken,accessToken,markUse,suspend};
