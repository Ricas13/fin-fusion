'use strict';

const crypto=require('crypto');
const {query}=require('../db');
const provisioning=require('../jellyfin/provisioning-core');
const registry=require('../jellyfin/registry');
const {encryptWithEnv}=require('../security/purpose-crypto');
const managedSources=require('./managed-sources');
const entitlements=require('./entitlements');

function hiddenUsername(customerId){return `cf_stremio_${String(customerId).replace(/-/g,'').slice(0,12)}`;}
function password(){return crypto.randomBytes(32).toString('base64url');}
async function planFor(entitlement){const result=await query('SELECT * FROM plans WHERE id=$1',[entitlement.plan_id]);if(!result.rowCount)throw new Error('Stremio plan not found.');return result.rows[0];}
async function serverFor(serverId){const result=await query('SELECT * FROM jellyfin_servers WHERE id=$1',[serverId]);if(!result.rowCount)throw new Error('Managed Jellyfin server not found.');return result.rows[0];}
async function internalAccount(customerId,serverId){const result=await query(`SELECT * FROM jellyfin_accounts WHERE customer_id=$1 AND server_id=$2 AND account_purpose='stremio_internal' ORDER BY created_at LIMIT 1`,[customerId,serverId]);return result.rows[0]||null;}
async function applyPolicy(account,plan,effective,limit,disabled=false){const access=await provisioning.resolveLibraryAccessForServer(account.server_id,effective.unrestricted,effective.visibleNames,disabled),body={...provisioning.policyBody(effective.technical,disabled,access),MaxActiveSessions:disabled?0:limit,EnableContentDownloading:false,EnableSyncTranscoding:false,EnableMediaConversion:false,EnableLiveTvManagement:false,EnableUserPreferenceAccess:false};await registry.request(account.server_id,`/Users/${account.jellyfin_user_id}/Policy`,{method:'POST',body});return access;}
async function createMapping(entitlement,server,plan,effective,limit){const bootstrap=password(),account=await provisioning.createJellyfinAccount(entitlement.customer_id,server,effective,{preferredUsername:hiddenUsername(entitlement.customer_id),bootstrapPassword:bootstrap,makePrimary:false});await query(`UPDATE jellyfin_accounts SET account_purpose='stremio_internal',is_primary=FALSE,password_setup_required=FALSE,disabled=FALSE,updated_at=NOW() WHERE id=$1`,[account.id]);account.account_purpose='stremio_internal';account.disabled=false;await applyPolicy(account,plan,effective,limit,false);const auth=await entitlements.authenticateRestrictedUser(server.id,account.jellyfin_username,bootstrap);if(String(auth.userId)!==String(account.jellyfin_user_id))throw new Error('Restricted Jellyfin authentication returned the wrong user identity.');const encrypted=encryptWithEnv(auth.accessToken,entitlements.TOKEN_ENV,entitlements.TOKEN_PREFIX);return(await query(`INSERT INTO stremio_managed_accounts(entitlement_id,customer_id,server_id,jellyfin_account_id,access_token_encrypted,token_issued_at,status,last_error) VALUES($1,$2,$3,$4,$5,NOW(),'active',NULL) ON CONFLICT(entitlement_id,server_id) DO UPDATE SET jellyfin_account_id=EXCLUDED.jellyfin_account_id,access_token_encrypted=EXCLUDED.access_token_encrypted,token_issued_at=NOW(),status='active',last_error=NULL,updated_at=NOW() RETURNING *`,[entitlement.id,entitlement.customer_id,server.id,account.id,encrypted])).rows[0];}
async function recoverMapping(entitlement,server,account,plan,effective,limit,prior=null){await applyPolicy(account,plan,effective,limit,false);await query(`UPDATE jellyfin_accounts SET disabled=FALSE,is_primary=FALSE,password_setup_required=FALSE,updated_at=NOW() WHERE id=$1`,[account.id]);const rotated=await entitlements.refreshRestrictedAccess(account,server,prior?.access_token_encrypted||null);return(await query(`INSERT INTO stremio_managed_accounts(entitlement_id,customer_id,server_id,jellyfin_account_id,access_token_encrypted,token_issued_at,status,last_error) VALUES($1,$2,$3,$4,$5,$6,'active',NULL) ON CONFLICT(entitlement_id,server_id) DO UPDATE SET jellyfin_account_id=EXCLUDED.jellyfin_account_id,access_token_encrypted=EXCLUDED.access_token_encrypted,token_issued_at=EXCLUDED.token_issued_at,status='active',last_error=NULL,updated_at=NOW() RETURNING *`,[entitlement.id,entitlement.customer_id,server.id,account.id,rotated.encryptedToken,rotated.issuedAt])).rows[0];}
async function disableMapping(row,reason='Managed Stremio access suspended'){
  const account={id:row.jellyfin_account_id,customer_id:row.customer_id,server_id:row.server_id,jellyfin_user_id:row.jellyfin_user_id,jellyfin_username:row.jellyfin_username,account_purpose:'stremio_internal'};
  await entitlements.logoutRestrictedToken({id:row.server_id,name:row.server_name,base_url:row.base_url},row.access_token_encrypted).catch(()=>{});
  await provisioning.disableJellyfinAccount(account).catch(error=>console.warn(`Unable to disable managed Stremio Jellyfin account ${row.jellyfin_account_id}:`,error.message));
  await query(`UPDATE stremio_managed_accounts SET status='suspended',last_error=$2,updated_at=NOW() WHERE id=$1`,[row.mapping_id,String(reason).slice(0,1000)]);
}
async function disableStale(entitlement,allowedIds){const rows=(await query(`SELECT sma.id mapping_id,sma.customer_id,sma.server_id,sma.jellyfin_account_id,sma.access_token_encrypted,ja.jellyfin_user_id,ja.jellyfin_username,js.name server_name,js.base_url FROM stremio_managed_accounts sma JOIN jellyfin_accounts ja ON ja.id=sma.jellyfin_account_id JOIN jellyfin_servers js ON js.id=sma.server_id WHERE sma.entitlement_id=$1 AND NOT (sma.server_id=ANY($2::uuid[])) AND sma.status='active'`,[entitlement.id,allowedIds])).rows;for(const row of rows)await disableMapping(row,'Managed Stremio source disabled.');}
async function revokeInactiveMappings(){const rows=(await query(`WITH effective AS (SELECT customer_id,subscription_id,access_expires_at,blocked FROM effective_customer_entitlements UNION ALL SELECT customer_id,subscription_id,access_expires_at,blocked FROM effective_customer_addons) SELECT sma.id mapping_id,sma.customer_id,sma.server_id,sma.jellyfin_account_id,sma.access_token_encrypted,ja.jellyfin_user_id,ja.jellyfin_username,js.name server_name,js.base_url FROM stremio_managed_accounts sma JOIN stremio_entitlements e ON e.id=sma.entitlement_id JOIN jellyfin_accounts ja ON ja.id=sma.jellyfin_account_id JOIN jellyfin_servers js ON js.id=sma.server_id LEFT JOIN effective ee ON ee.customer_id=e.customer_id AND ee.subscription_id=e.subscription_id WHERE sma.status='active' AND (e.status<>'active' OR js.enabled=FALSE OR js.stremio_enabled=FALSE OR ee.subscription_id IS NULL OR ee.blocked=TRUE OR ee.access_expires_at<=NOW())`)).rows;for(const row of rows)await disableMapping(row,'Managed Stremio entitlement is no longer active.');return rows.length;}
async function currentMappings(entitlementId,serverIds){if(!serverIds.length)return[];return(await query(`SELECT sma.*,ja.jellyfin_user_id,ja.jellyfin_username,ja.disabled account_disabled FROM stremio_managed_accounts sma JOIN jellyfin_accounts ja ON ja.id=sma.jellyfin_account_id WHERE sma.entitlement_id=$1 AND sma.server_id=ANY($2::uuid[])`,[entitlementId,serverIds])).rows;}
async function ensure(entitlement){
  if(!entitlement?.id||!entitlement?.customer_id||!entitlement?.plan_id)return[];
  const sources=await managedSources.enabled(),allowedIds=sources.map(source=>source.id);await disableStale(entitlement,allowedIds);if(!sources.length)return[];
  const existing=await currentMappings(entitlement.id,allowedIds),byServer=new Map(existing.map(row=>[String(row.server_id),row]));
  if(sources.every(source=>{const row=byServer.get(String(source.id));return row&&row.status==='active'&&!row.account_disabled&&row.access_token_encrypted;}))return existing;
  const plan=await planFor(entitlement),limit=entitlements.streamLimit(entitlement),effective=await provisioning.effectivePolicyForCustomer(entitlement.customer_id,plan);
  const settled=await Promise.allSettled(sources.map(async source=>{const prior=byServer.get(String(source.id));if(prior&&prior.status==='active'&&!prior.account_disabled&&prior.access_token_encrypted)return prior;const server=await serverFor(source.id),account=await internalAccount(entitlement.customer_id,source.id);return account?recoverMapping(entitlement,server,account,plan,effective,limit,prior):createMapping(entitlement,server,plan,effective,limit);}));
  const ready=[];for(let i=0;i<settled.length;i+=1){const result=settled[i],source=sources[i];if(result.status==='fulfilled'){ready.push(result.value);continue;}await query(`UPDATE stremio_managed_accounts SET status='error',last_error=$3,updated_at=NOW() WHERE entitlement_id=$1 AND server_id=$2`,[entitlement.id,source.id,String(result.reason?.message||result.reason).slice(0,1000)]).catch(()=>{});console.warn(`Managed Stremio identity provisioning failed on ${source.name}:`,result.reason?.message||result.reason);}return ready;
}
async function mappings(entitlement){await ensure(entitlement);return managedSources.accountsForEntitlement(entitlement.id);}
async function syncActive(){
  const revoked=await revokeInactiveMappings();
  const rows=(await query(`WITH effective AS (
      SELECT customer_id,subscription_id,access_expires_at,blocked FROM effective_customer_entitlements
      UNION ALL
      SELECT customer_id,subscription_id,access_expires_at,blocked FROM effective_customer_addons
    )
    SELECT e.id,e.customer_id,e.stream_limit,s.plan_id
    FROM stremio_entitlements e
    JOIN subscriptions s ON s.id=e.subscription_id
    JOIN effective ee ON ee.customer_id=e.customer_id AND ee.subscription_id=e.subscription_id
    WHERE e.status='active' AND ee.blocked=FALSE AND ee.access_expires_at>NOW()`)).rows;
  let processed=0,failed=0;
  for(const entitlement of rows){try{await ensure(entitlement);const accounts=await managedSources.accountsForEntitlement(entitlement.id);if(accounts.length){const plan=await planFor(entitlement),effective=await provisioning.effectivePolicyForCustomer(entitlement.customer_id,plan),limit=entitlements.streamLimit(entitlement);for(const account of accounts)await applyPolicy(account,plan,effective,limit,false);}processed+=1;}catch(error){failed+=1;console.warn(`Managed Stremio policy sync failed for ${entitlement.id}:`,error.message);}}
  return{total:rows.length,processed,failed,revoked};
}

module.exports={hiddenUsername,planFor,serverFor,internalAccount,applyPolicy,ensure,mappings,disableStale,disableMapping,revokeInactiveMappings,currentMappings,syncActive};
