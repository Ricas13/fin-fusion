'use strict';

const crypto=require('crypto');
const {query}=require('../db');
const provisioning=require('../jellyfin/provisioning');
const registry=require('../jellyfin/registry');
const policyControl=require('../jellyfin/reconciliation-control');
const {encryptWithEnv,decryptWithEnv}=require('../security/purpose-crypto');
const managedSources=require('./managed-sources');
const entitlements=require('./entitlements');
const operationLock=require('./operation-lock');

const PASSWORD_PREFIX='stremio-jf-managed-password';
const REMOTE_PRESENCE_TTL_MS=60*1000;
const policyReady=new Set();
const remotePresenceChecked=new Map();
function hiddenUsername(customerId){return `cf_stremio_${String(customerId).replace(/-/g,'').slice(0,12)}`;}
function password(){return crypto.randomBytes(32).toString('base64url');}
function encryptPlaybackPassword(value){return encryptWithEnv(String(value),entitlements.TOKEN_ENV,PASSWORD_PREFIX);}
function decryptPlaybackPassword(row){return row?.playback_password_encrypted?decryptWithEnv(row.playback_password_encrypted,entitlements.TOKEN_ENV,PASSWORD_PREFIX):null;}
function policyKey(account){return `${String(account?.server_id||'')}:${String(account?.jellyfin_user_id||'')}`;}
function mappingReady(row){return Boolean(row&&row.status==='active'&&!row.account_disabled&&row.access_token_encrypted&&row.playback_password_encrypted);}
function cleanFailure(value){return String(value||'Unknown managed Stremio failure').replace(/[\r\n\t\u2028\u2029]+/g,' ').replace(/\s{2,}/g,' ').trim().slice(0,300)||'Unknown managed Stremio failure';}
function summarizeFailures(reasons,failed,label='managed Stremio synchronization'){if(!failed)return null;const ranked=[...reasons.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])),shown=ranked.slice(0,2),shownCount=shown.reduce((sum,[,count])=>sum+count,0),detail=shown.map(([message,count])=>`${count}× ${message}`).join('; '),remainder=Math.max(0,failed-shownCount);return `${failed} ${label} failure${failed===1?'':'s'}${detail?`: ${detail}`:''}${remainder?`; ${remainder} other failure${remainder===1?'':'s'}`:''}`.slice(0,1000);}
function remoteMissing(error){return Number(error?.status||0)===404||/\b404\b|not found|not\s+exist/i.test(String(error?.message||error||''));}
function presenceFresh(account){const at=remotePresenceChecked.get(policyKey(account));return Number.isFinite(at)&&Date.now()-at<REMOTE_PRESENCE_TTL_MS;}
function markPresence(account){remotePresenceChecked.set(policyKey(account),Date.now());}
function clearPresence(account){remotePresenceChecked.delete(policyKey(account));}
async function planFor(entitlement){const result=await query('SELECT * FROM plans WHERE id=$1',[entitlement.plan_id]);if(!result.rowCount)throw new Error('Stremio plan not found.');return result.rows[0];}
async function serverFor(serverId){const result=await query('SELECT * FROM jellyfin_servers WHERE id=$1',[serverId]);if(!result.rowCount)throw new Error('Managed media server not found.');return result.rows[0];}
async function internalAccount(customerId,serverId){const result=await query(`SELECT * FROM jellyfin_accounts WHERE customer_id=$1 AND server_id=$2 AND account_purpose='stremio_internal' ORDER BY created_at LIMIT 1`,[customerId,serverId]);return result.rows[0]||null;}
async function applyPolicy(account,effective,disabled=false){
  const access=await provisioning.resolveLibraryAccessForServer(account.server_id,effective.unrestricted,effective.visibleNames,disabled),body={...provisioning.policyBody(effective.technical,disabled,access),EnableRemoteAccess:!disabled,MaxActiveSessions:0,EnableContentDownloading:false,EnableSyncTranscoding:false,EnableMediaConversion:false,EnableLiveTvManagement:false,EnableUserPreferenceAccess:false},key=policyKey(account);
  const remote=await registry.request(account.server_id,`/Users/${encodeURIComponent(account.jellyfin_user_id)}`,{method:'GET',timeoutMs:5000});markPresence(account);
  if(remote&&typeof remote==='object'&&remote.Policy&&policyControl.policyMatches(remote,body)){if(disabled){policyReady.delete(key);clearPresence(account);}else policyReady.add(key);return{...access,unchanged:true};}
  await registry.request(account.server_id,`/Users/${account.jellyfin_user_id}/Policy`,{method:'POST',body});if(disabled){policyReady.delete(key);clearPresence(account);}else{policyReady.add(key);markPresence(account);}return access;
}
async function createMapping(entitlement,server,effective){
  const bootstrap=password(),account=await provisioning.createJellyfinAccount(entitlement.customer_id,server,effective,{preferredUsername:hiddenUsername(entitlement.customer_id),bootstrapPassword:bootstrap,makePrimary:false});
  await query(`UPDATE jellyfin_accounts SET account_purpose='stremio_internal',is_primary=FALSE,password_setup_required=FALSE,disabled=FALSE,updated_at=NOW() WHERE id=$1`,[account.id]);account.account_purpose='stremio_internal';account.disabled=false;
  await applyPolicy(account,effective,false);const auth=await entitlements.authenticateRestrictedUser(server.id,account.jellyfin_username,bootstrap);if(String(auth.userId)!==String(account.jellyfin_user_id))throw new Error('Restricted media-server authentication returned the wrong user identity.');
  const encrypted=encryptWithEnv(auth.accessToken,entitlements.TOKEN_ENV,entitlements.TOKEN_PREFIX),encryptedPassword=encryptPlaybackPassword(bootstrap);
  return(await query(`INSERT INTO stremio_managed_accounts(entitlement_id,customer_id,server_id,jellyfin_account_id,access_token_encrypted,playback_password_encrypted,token_issued_at,status,last_error) VALUES($1,$2,$3,$4,$5,$6,NOW(),'active',NULL) ON CONFLICT(entitlement_id,server_id) DO UPDATE SET jellyfin_account_id=EXCLUDED.jellyfin_account_id,access_token_encrypted=EXCLUDED.access_token_encrypted,playback_password_encrypted=EXCLUDED.playback_password_encrypted,token_issued_at=NOW(),status='active',last_error=NULL,updated_at=NOW() RETURNING *`,[entitlement.id,entitlement.customer_id,server.id,account.id,encrypted,encryptedPassword])).rows[0];
}
async function recoverMapping(entitlement,server,account,effective,prior=null){
  if(prior?.access_token_encrypted){const loggedOut=await entitlements.logoutRestrictedToken(server,prior.access_token_encrypted);if(!loggedOut)throw new Error('Could not verify revocation of the previous managed Stremio token. Recovery will retry without discarding it.');}
  await applyPolicy(account,effective,false);await query(`UPDATE jellyfin_accounts SET disabled=FALSE,is_primary=FALSE,password_setup_required=FALSE,updated_at=NOW() WHERE id=$1`,[account.id]);
  const nextPassword=password();await registry.request(server.id,`/Users/${account.jellyfin_user_id}/Password`,{method:'POST',body:{Id:account.jellyfin_user_id,NewPw:nextPassword}});const auth=await entitlements.authenticateRestrictedUser(server.id,account.jellyfin_username,nextPassword);if(String(auth.userId)!==String(account.jellyfin_user_id))throw new Error('Restricted media-server authentication returned the wrong user identity.');
  const encryptedToken=encryptWithEnv(auth.accessToken,entitlements.TOKEN_ENV,entitlements.TOKEN_PREFIX),encryptedPassword=encryptPlaybackPassword(nextPassword);
  markPresence(account);
  return(await query(`INSERT INTO stremio_managed_accounts(entitlement_id,customer_id,server_id,jellyfin_account_id,access_token_encrypted,playback_password_encrypted,token_issued_at,status,last_error) VALUES($1,$2,$3,$4,$5,$6,NOW(),'active',NULL) ON CONFLICT(entitlement_id,server_id) DO UPDATE SET jellyfin_account_id=EXCLUDED.jellyfin_account_id,access_token_encrypted=EXCLUDED.access_token_encrypted,playback_password_encrypted=EXCLUDED.playback_password_encrypted,token_issued_at=NOW(),status='active',last_error=NULL,updated_at=NOW() RETURNING *`,[entitlement.id,entitlement.customer_id,server.id,account.id,encryptedToken,encryptedPassword])).rows[0];
}
async function otherActiveMappingOwns(accountId,mappingId){if(!accountId)return false;const result=await query(`SELECT EXISTS(SELECT 1 FROM stremio_managed_accounts WHERE jellyfin_account_id=$1 AND id<>$2 AND status='active') yes`,[accountId,mappingId]);return result.rows[0]?.yes===true;}
async function disableMapping(row,reason='Managed Stremio access suspended'){
  const account={id:row.jellyfin_account_id,customer_id:row.customer_id,server_id:row.server_id,jellyfin_user_id:row.jellyfin_user_id,jellyfin_username:row.jellyfin_username,account_purpose:'stremio_internal'};
  policyReady.delete(policyKey(account));clearPresence(account);
  try{
    if(row.access_token_encrypted){const loggedOut=await entitlements.logoutRestrictedToken({id:row.server_id,name:row.server_name,base_url:row.base_url,media_server_type:row.media_server_type},row.access_token_encrypted);if(!loggedOut)throw new Error('Media server did not confirm managed Stremio token logout.');}
    const shared=await otherActiveMappingOwns(row.jellyfin_account_id,row.mapping_id);
    if(!shared)await provisioning.disableJellyfinAccount(account);
    await query(`UPDATE stremio_managed_accounts SET status='suspended',last_error=$2,updated_at=NOW() WHERE id=$1`,[row.mapping_id,String(reason).slice(0,1000)]);
    return true;
  }catch(error){
    await query(`UPDATE stremio_managed_accounts SET status='error',last_error=$2,updated_at=NOW() WHERE id=$1`,[row.mapping_id,String(error?.message||error).slice(0,1000)]).catch(()=>{});
    throw error;
  }
}
async function disableStale(entitlement,allowedIds){const rows=(await query(`SELECT sma.id mapping_id,sma.customer_id,sma.server_id,sma.jellyfin_account_id,sma.access_token_encrypted,ja.jellyfin_user_id,ja.jellyfin_username,js.name server_name,js.base_url,js.media_server_type FROM stremio_managed_accounts sma JOIN jellyfin_accounts ja ON ja.id=sma.jellyfin_account_id JOIN jellyfin_servers js ON js.id=sma.server_id WHERE sma.entitlement_id=$1 AND NOT (sma.server_id=ANY($2::uuid[])) AND sma.status IN('active','error')`,[entitlement.id,allowedIds])).rows;for(const row of rows)await disableMapping(row,'Managed Stremio source disabled.');}
async function inactiveMappingRows(customerId=null){
  const params=[];let customerFilter='';
  if(customerId){params.push(customerId);customerFilter='AND sma.customer_id=$1';}
  return(await query(`WITH effective AS (SELECT customer_id,subscription_id,access_expires_at,blocked FROM effective_stremio_entitlements UNION ALL SELECT customer_id,subscription_id,access_expires_at,blocked FROM effective_customer_addons) SELECT sma.id mapping_id,sma.customer_id,sma.server_id,sma.jellyfin_account_id,sma.access_token_encrypted,ja.jellyfin_user_id,ja.jellyfin_username,js.name server_name,js.base_url,js.media_server_type FROM stremio_managed_accounts sma JOIN stremio_entitlements e ON e.id=sma.entitlement_id JOIN jellyfin_accounts ja ON ja.id=sma.jellyfin_account_id JOIN jellyfin_servers js ON js.id=sma.server_id LEFT JOIN effective ee ON ee.customer_id=e.customer_id AND ee.subscription_id=e.subscription_id WHERE sma.status IN('active','error') ${customerFilter} AND (e.status<>'active' OR js.enabled=FALSE OR js.stremio_enabled=FALSE OR ee.subscription_id IS NULL OR ee.blocked=TRUE OR ee.access_expires_at<=NOW())`,params)).rows;
}
async function revokeInactiveMappings({customerId=null}={}){const rows=await inactiveMappingRows(customerId);let revoked=0,failed=0;const failureReasons=new Map();for(const row of rows){try{await disableMapping(row,'Managed Stremio entitlement is no longer active.');revoked++;}catch(error){failed++;const reason=cleanFailure(error?.message||error);failureReasons.set(reason,Number(failureReasons.get(reason)||0)+1);console.warn(`Managed Stremio suspension will retry for ${row.mapping_id}:`,error.message);}}const warning=summarizeFailures(failureReasons,failed,'managed Stremio cleanup');return{total:rows.length,revoked,failed,...(warning?{warning}:{})};}
async function revokeCustomerInactiveMappings(customerId){return revokeInactiveMappings({customerId});}
async function currentMappings(entitlementId,serverIds){if(!serverIds.length)return[];return(await query(`SELECT sma.*,ja.jellyfin_user_id,ja.jellyfin_username,ja.disabled account_disabled FROM stremio_managed_accounts sma JOIN jellyfin_accounts ja ON ja.id=sma.jellyfin_account_id WHERE sma.entitlement_id=$1 AND sma.server_id=ANY($2::uuid[])`,[entitlementId,serverIds])).rows;}
async function recreateMissingManagedAccount(entitlement,server,account,effective){
  const stale={accountId:account.id,serverId:account.server_id,remoteUserId:account.jellyfin_user_id,username:account.jellyfin_username};
  clearPresence(account);policyReady.delete(policyKey(account));
  await provisioning.deleteJellyfinAccount(account,{reason:'Remote managed Stremio identity was already missing during reconciliation'});
  await query(`DELETE FROM stremio_managed_accounts WHERE entitlement_id=$1 AND server_id=$2`,[entitlement.id,server.id]).catch(()=>{});
  const created=await createMapping(entitlement,server,effective);
  await query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('stremio.managed.remote_missing.recreated','customer',$1,$2::jsonb)`,[entitlement.customer_id,JSON.stringify({...stale,newMappingId:created.id,newAccountId:created.jellyfin_account_id})]);
  return created;
}
async function ensureSource(entitlement,source,effective){return operationLock.withLock(`managed-account:${entitlement.customer_id}:${source.id}`,async()=>{const current=(await currentMappings(entitlement.id,[source.id]))[0]||null;const server=await serverFor(source.id),account=await internalAccount(entitlement.customer_id,source.id);if(!account)return createMapping(entitlement,server,effective);if(!presenceFresh(account)){try{await registry.request(server.id,`/Users/${encodeURIComponent(account.jellyfin_user_id)}`,{method:'GET',timeoutMs:5000});markPresence(account);}catch(error){if(!remoteMissing(error))throw error;return recreateMissingManagedAccount(entitlement,server,account,effective);}}if(mappingReady(current))return current;return recoverMapping(entitlement,server,account,effective,current);});}
async function ensure(entitlement){
  if(!entitlement?.id||!entitlement?.customer_id||!entitlement?.plan_id)return[];
  const sources=await managedSources.enabled(),allowedIds=sources.map(source=>source.id);await disableStale(entitlement,allowedIds);if(!sources.length)return[];
  const plan=await planFor(entitlement),effective=await provisioning.effectivePolicyForCustomer(entitlement.customer_id,plan);
  const settled=await Promise.allSettled(sources.map(source=>ensureSource(entitlement,source,effective)));
  const ready=[];for(let i=0;i<settled.length;i+=1){const result=settled[i],source=sources[i];if(result.status==='fulfilled'){ready.push(result.value);continue;}await query(`UPDATE stremio_managed_accounts SET status='error',last_error=$3,updated_at=NOW() WHERE entitlement_id=$1 AND server_id=$2`,[entitlement.id,source.id,String(result.reason?.message||result.reason).slice(0,1000)]).catch(()=>{});console.warn(`Managed Stremio identity provisioning failed on ${source.name}:`,result.reason?.message||result.reason);}return ready;
}
async function mappings(entitlement){await ensure(entitlement);const accounts=await managedSources.accountsForEntitlement(entitlement.id),pending=accounts.filter(account=>!policyReady.has(policyKey(account)));if(pending.length){const plan=await planFor(entitlement),effective=await provisioning.effectivePolicyForCustomer(entitlement.customer_id,plan);for(const account of pending)await applyPolicy(account,effective,false);}return accounts;}
async function syncActive(){
  const revocation=await revokeInactiveMappings();
  const rows=(await query(`WITH effective AS (
      SELECT customer_id,subscription_id,access_expires_at,blocked FROM effective_stremio_entitlements
      UNION ALL
      SELECT customer_id,subscription_id,access_expires_at,blocked FROM effective_customer_addons
    )
    SELECT e.id,e.customer_id,s.plan_id
    FROM stremio_entitlements e
    JOIN subscriptions s ON s.id=e.subscription_id
    JOIN effective ee ON ee.customer_id=e.customer_id AND ee.subscription_id=e.subscription_id
    WHERE e.status='active' AND ee.blocked=FALSE AND ee.access_expires_at>NOW()`)).rows;
  let processed=0,failed=Number(revocation.failed||0);const failureReasons=new Map();
  for(const entitlement of rows){try{await mappings(entitlement);processed+=1;}catch(error){failed+=1;const reason=cleanFailure(error?.message||error);failureReasons.set(reason,Number(failureReasons.get(reason)||0)+1);console.warn(`Managed Stremio policy sync failed for ${entitlement.id}:`,error.message);}}
  const syncFailed=Math.max(0,failed-Number(revocation.failed||0)),syncWarning=summarizeFailures(failureReasons,syncFailed),warning=[revocation.warning,syncWarning].filter(Boolean).join('; ').slice(0,1000)||null;
  return{total:rows.length+Number(revocation.total||0),processed:processed+Number(revocation.revoked||0),failed,revoked:Number(revocation.revoked||0),revocation,...(warning?{warning}:{})};
}

module.exports={PASSWORD_PREFIX,REMOTE_PRESENCE_TTL_MS,hiddenUsername,password,encryptPlaybackPassword,decryptPlaybackPassword,policyKey,mappingReady,cleanFailure,summarizeFailures,remoteMissing,presenceFresh,markPresence,clearPresence,planFor,serverFor,internalAccount,applyPolicy,ensureSource,ensure,mappings,otherActiveMappingOwns,disableStale,disableMapping,inactiveMappingRows,revokeInactiveMappings,revokeCustomerInactiveMappings,recreateMissingManagedAccount,currentMappings,syncActive};
