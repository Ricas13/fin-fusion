'use strict';

const crypto=require('crypto');
const {query,transaction}=require('../db');
const provisioning=require('../jellyfin/provisioning-core');
const registry=require('../jellyfin/registry');
const {encryptWithEnv}=require('../security/purpose-crypto');
const managedSources=require('./managed-sources');
const entitlements=require('./entitlements');

function hiddenUsername(customerId){return `cf_stremio_${String(customerId).replace(/-/g,'').slice(0,12)}`;}
function password(){return crypto.randomBytes(32).toString('base64url');}
async function planFor(entitlement){
  const result=await query('SELECT * FROM plans WHERE id=$1',[entitlement.plan_id]);
  if(!result.rowCount)throw new Error('Stremio plan not found.');
  return result.rows[0];
}
async function serverFor(serverId){
  const result=await query('SELECT * FROM jellyfin_servers WHERE id=$1',[serverId]);
  if(!result.rowCount)throw new Error('Managed Jellyfin server not found.');
  return result.rows[0];
}
async function internalAccount(customerId,serverId){
  const result=await query(`SELECT * FROM jellyfin_accounts
    WHERE customer_id=$1 AND server_id=$2 AND account_purpose='stremio_internal'
    ORDER BY created_at LIMIT 1`,[customerId,serverId]);
  return result.rows[0]||null;
}
async function applyPolicy(account,plan,effective,limit,disabled=false){
  const access=await provisioning.resolveLibraryAccessForServer(account.server_id,effective.unrestricted,effective.visibleNames,disabled);
  const body={
    ...provisioning.policyBody(effective.technical,disabled,access),
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
async function createMapping(entitlement,server,plan,effective,limit){
  const bootstrap=password();
  const account=await provisioning.createJellyfinAccount(entitlement.customer_id,server,effective,{
    preferredUsername:hiddenUsername(entitlement.customer_id),bootstrapPassword:bootstrap,makePrimary:false
  });
  await query(`UPDATE jellyfin_accounts SET account_purpose='stremio_internal',is_primary=FALSE,
    password_setup_required=FALSE,disabled=FALSE,updated_at=NOW() WHERE id=$1`,[account.id]);
  account.account_purpose='stremio_internal';
  account.disabled=false;
  await applyPolicy(account,plan,effective,limit,false);
  const auth=await entitlements.authenticateRestrictedUser(server.id,account.jellyfin_username,bootstrap);
  if(String(auth.userId)!==String(account.jellyfin_user_id))throw new Error('Restricted Jellyfin authentication returned the wrong user identity.');
  const encrypted=encryptWithEnv(auth.accessToken,entitlements.TOKEN_ENV,entitlements.TOKEN_PREFIX);
  const result=await query(`INSERT INTO stremio_managed_accounts(
      entitlement_id,customer_id,server_id,jellyfin_account_id,access_token_encrypted,token_issued_at,status,last_error)
    VALUES($1,$2,$3,$4,$5,NOW(),'active',NULL)
    ON CONFLICT(entitlement_id,server_id) DO UPDATE SET jellyfin_account_id=EXCLUDED.jellyfin_account_id,
      access_token_encrypted=EXCLUDED.access_token_encrypted,token_issued_at=NOW(),status='active',last_error=NULL,updated_at=NOW()
    RETURNING *`,[entitlement.id,entitlement.customer_id,server.id,account.id,encrypted]);
  return result.rows[0];
}
async function recoverMapping(entitlement,server,account,plan,effective,limit,prior=null){
  await applyPolicy(account,plan,effective,limit,false);
  await query(`UPDATE jellyfin_accounts SET disabled=FALSE,is_primary=FALSE,password_setup_required=FALSE,updated_at=NOW() WHERE id=$1`,[account.id]);
  const rotated=await entitlements.refreshRestrictedAccess(account,server,prior?.access_token_encrypted||null);
  const result=await query(`INSERT INTO stremio_managed_accounts(
      entitlement_id,customer_id,server_id,jellyfin_account_id,access_token_encrypted,token_issued_at,status,last_error)
    VALUES($1,$2,$3,$4,$5,$6,'active',NULL)
    ON CONFLICT(entitlement_id,server_id) DO UPDATE SET jellyfin_account_id=EXCLUDED.jellyfin_account_id,
      access_token_encrypted=EXCLUDED.access_token_encrypted,token_issued_at=EXCLUDED.token_issued_at,
      status='active',last_error=NULL,updated_at=NOW()
    RETURNING *`,[entitlement.id,entitlement.customer_id,server.id,account.id,rotated.encryptedToken,rotated.issuedAt]);
  return result.rows[0];
}
async function disableStale(entitlement,allowedIds){
  const rows=(await query(`SELECT sma.*,ja.* FROM stremio_managed_accounts sma
    JOIN jellyfin_accounts ja ON ja.id=sma.jellyfin_account_id
    WHERE sma.entitlement_id=$1 AND NOT (sma.server_id=ANY($2::uuid[])) AND sma.status='active'`,[entitlement.id,allowedIds])).rows;
  for(const row of rows){
    await provisioning.disableJellyfinAccount(row).catch(()=>{});
    await query(`UPDATE stremio_managed_accounts SET status='suspended',updated_at=NOW() WHERE id=$1`,[row.id]).catch(()=>{});
  }
}
async function ensure(entitlement){
  if(!entitlement?.id||!entitlement?.customer_id||!entitlement?.plan_id)return[];
  const sources=await managedSources.enabled();
  if(!sources.length)return[];
  const plan=await planFor(entitlement),limit=entitlements.streamLimit(entitlement),effective=await provisioning.effectivePolicyForCustomer(entitlement.customer_id,plan);
  const allowedIds=sources.map(source=>source.id);
  await disableStale(entitlement,allowedIds);
  const ready=[];
  for(const source of sources){
    const existing=(await query(`SELECT sma.*,ja.jellyfin_user_id,ja.jellyfin_username,ja.disabled account_disabled
      FROM stremio_managed_accounts sma JOIN jellyfin_accounts ja ON ja.id=sma.jellyfin_account_id
      WHERE sma.entitlement_id=$1 AND sma.server_id=$2`,[entitlement.id,source.id])).rows[0]||null;
    if(existing&&existing.status==='active'&&!existing.account_disabled&&existing.access_token_encrypted){ready.push(existing);continue;}
    const server=await serverFor(source.id);
    try{
      let account=existing?await internalAccount(entitlement.customer_id,source.id):await internalAccount(entitlement.customer_id,source.id);
      const mapped=account
        ?await recoverMapping(entitlement,server,account,plan,effective,limit,existing)
        :await createMapping(entitlement,server,plan,effective,limit);
      ready.push(mapped);
    }catch(error){
      await query(`UPDATE stremio_managed_accounts SET status='error',last_error=$3,updated_at=NOW()
        WHERE entitlement_id=$1 AND server_id=$2`,[entitlement.id,source.id,String(error.message||error).slice(0,1000)]).catch(()=>{});
      console.warn(`Managed Stremio identity provisioning failed on ${source.name}:`,error.message);
    }
  }
  return ready;
}
async function mappings(entitlement){
  await ensure(entitlement);
  return managedSources.accountsForEntitlement(entitlement.id);
}

module.exports={hiddenUsername,planFor,serverFor,internalAccount,applyPolicy,ensure,mappings};
