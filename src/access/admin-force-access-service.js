'use strict';

const {query,transaction}=require('../db');
const permanentAccess=require('../entitlements/permanent-access');
const subscriptionState=require('../entitlements/subscription-state');
const provisioning=require('../jellyfin/resilient-provisioning');
const manualAssignment=require('../jellyfin/manual-assignment');
const durableCreation=require('../jellyfin/durable-account-creation');
const forceMove=require('../jellyfin/admin-force-move');
const adminControl=require('../jellyfin/admin-control');

function clean(value,max=500){return String(value==null?'':value).trim().slice(0,max);}
function serviceType(entitlement){return String(entitlement?.service_type_snapshot||entitlement?.service_type||'jellyfin').toLowerCase();}

async function recoverCreatedAccount(customerId,target,entitlement,{actorUserId=null}={}){
  const accessLane=provisioning.requestedAccessLane(entitlement);
  const intent=await durableCreation.loadIntent(customerId,target.id);
  if(!intent?.remote_user_id)throw new Error('The remote Jellyfin user was created, but its recovery record is missing.');
  const remote=await durableCreation.findRemoteByName(target.id,intent.username);
  if(!remote?.Id||String(remote.Id)!==String(intent.remote_user_id))throw new Error('The remote Jellyfin user could not be verified safely for local recovery.');

  const account=await transaction(async client=>{
    const matches=await client.query(`
      SELECT * FROM jellyfin_accounts
      WHERE server_id=$1 AND (jellyfin_user_id=$2 OR jellyfin_username=$3)
      FOR UPDATE
    `,[target.id,String(remote.Id),intent.username]);
    if(matches.rows.some(row=>String(row.customer_id)!==String(customerId)))throw new Error('The remote Jellyfin identity is already linked to another customer.');
    if(matches.rows.length>1)throw new Error('Multiple local Jellyfin rows match the recovered remote identity.');

    let stored;
    if(matches.rowCount===1){
      const existing=matches.rows[0];
      if(String(existing.account_purpose||'jellyfin')!=='jellyfin')throw new Error('The recovered Jellyfin identity is reserved for an internal service account.');
      const updated=await client.query(`
        UPDATE jellyfin_accounts
        SET customer_id=$1,jellyfin_user_id=$2,jellyfin_username=$3,disabled=FALSE,
            last_policy_sync=NOW(),password_setup_required=TRUE,password_reset_required=FALSE,
            account_purpose='jellyfin',
            access_lane_changed_at=CASE WHEN access_lane IS DISTINCT FROM $5 THEN NOW() ELSE access_lane_changed_at END,
            inactivity_observation_reset_at=CASE WHEN access_lane IS DISTINCT FROM $5 THEN NULL ELSE inactivity_observation_reset_at END,
            access_lane=$5,updated_at=NOW()
        WHERE id=$4
        RETURNING *
      `,[customerId,String(remote.Id),intent.username,existing.id,accessLane]);
      stored=updated.rows[0];
    }else{
      const inserted=await client.query(`
        INSERT INTO jellyfin_accounts(
          customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,last_policy_sync,
          is_primary,password_setup_required,password_reset_required,account_purpose,access_lane
        ) VALUES($1,$2,$3,$4,FALSE,NOW(),FALSE,TRUE,FALSE,'jellyfin',$5)
        RETURNING *
      `,[customerId,target.id,String(remote.Id),intent.username,accessLane]);
      stored=inserted.rows[0];
    }
    await client.query(`UPDATE jellyfin_accounts SET is_primary=FALSE,updated_at=NOW() WHERE customer_id=$1 AND account_purpose='jellyfin' AND id<>$2`,[customerId,stored.id]);
    const primary=await client.query(`UPDATE jellyfin_accounts SET is_primary=TRUE,updated_at=NOW() WHERE id=$1 RETURNING *`,[stored.id]);
    await client.query('DELETE FROM jellyfin_account_creation_intents WHERE id=$1',[intent.id]);
    return primary.rows[0];
  });

  await adminControl.forceServer(customerId,entitlement.subscription_id,target.id,{actorUserId,reason:'Recovered forced Jellyfin access after local persistence failure'});
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.jellyfin.force_recover','customer',$2,$3::jsonb)`,[actorUserId,customerId,JSON.stringify({serverId:target.id,serverName:target.name,accountId:account.id,remoteUserId:remote.Id,username:intent.username,accessLane})]);
  return account;
}

async function forceAccess(customerId,serverId,{actorUserId=null}={}){
  const initial=await manualAssignment.candidates(customerId);
  if(!initial.entitlement)throw new Error('This customer does not have a Jellyfin plan. Add a Jellyfin or bundle plan first.');
  if(!['jellyfin','bundle'].includes(serviceType(initial.entitlement)))throw new Error('The current plan does not include Jellyfin access.');
  const target=initial.servers.find(server=>String(server.id)===String(serverId));
  if(!target)throw new Error('Choose an enabled Jellyfin server.');

  await permanentAccess.enable(customerId,{actorUserId,reason:`Forced Jellyfin access to ${target.name} by administrator`});

  const current=await manualAssignment.candidates(customerId);
  const accessLane=provisioning.requestedAccessLane(current.entitlement);
  const active=(current.activeAccounts||[]).filter(account=>String(account.access_lane||'primary')===accessLane);
  const onTarget=active.find(account=>String(account.server_id)===String(target.id));
  let result;
  if(onTarget){
    await adminControl.forceServer(customerId,current.entitlement.subscription_id,target.id,{actorUserId,reason:'Forced Jellyfin access by administrator'});
    await provisioning.reconcileCustomer(customerId);
    result={server:target,account:onTarget,action:'kept'};
  }else if(active.length){
    const moved=await forceMove.move(customerId,target.id,{actorUserId});
    result={server:moved.target,account:moved.targetAccount,action:'moved'};
  }else{
    try{
      const assigned=await manualAssignment.assign(customerId,target.id,{actorUserId});
      result={server:assigned.server,account:assigned.account,action:'assigned'};
    }catch(error){
      if(String(error?.code||'')!=='JELLYFIN_ACCOUNT_PERSIST_RETRYABLE')throw error;
      console.warn('Forced Jellyfin access is recovering a remotely-created account that failed local persistence.',{customerId,serverId:target.id,cause:error?.cause?.message||null});
      const account=await recoverCreatedAccount(customerId,target,current.entitlement,{actorUserId});
      result={server:target,account,action:'recovered'};
    }
  }

  return result;
}

async function returnToPlanRules(customerId,{actorUserId=null}={}){
  const entitlement=await subscriptionState.effectiveSubscription(customerId,{includeBlocked:true}).catch(()=>null);
  if(entitlement?.subscription_id){
    await adminControl.clear(customerId,entitlement.subscription_id,{actorUserId,reason:'Returned to normal plan and billing rules'});
  }
  await permanentAccess.revoke(customerId,{actorUserId,reason:'Returned to normal plan and billing rules'});
  let warning='';
  try{await provisioning.reconcileCustomer(customerId);}catch(error){warning=clean(error.message||error,240);}
  return{warning};
}

module.exports={forceAccess,returnToPlanRules,recoverCreatedAccount,serviceType};
