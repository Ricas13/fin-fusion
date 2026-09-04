'use strict';

const {query}=require('../db');
const provisioning=require('./provisioning');
const adminControl=require('./admin-control');

function same(a,b){return String(a||'')===String(b||'');}

async function targetServer(serverId){
  const result=await query(`
    SELECT * FROM jellyfin_servers
    WHERE id=$1 AND enabled=TRUE AND COALESCE(media_server_type,'jellyfin')='jellyfin'
    LIMIT 1
  `,[serverId]);
  return result.rows[0]||null;
}

async function customerAccounts(customerId){
  const result=await query(`
    SELECT ja.*,js.name AS server_name,js.enabled AS server_enabled
    FROM jellyfin_accounts ja
    JOIN jellyfin_servers js ON js.id=ja.server_id
    WHERE ja.customer_id=$1 AND ja.account_purpose='jellyfin'
    ORDER BY ja.is_primary DESC,ja.disabled ASC,ja.updated_at DESC
  `,[customerId]);
  return result.rows;
}

async function move(customerId,targetServerId,{actorUserId=null}={}){
  const entitlement=await require('../entitlements/subscription-state').effectiveSubscription(customerId,{includeBlocked:true});
  if(!entitlement)throw new Error('Give the customer a Jellyfin plan before moving them.');
  const service=String(entitlement.service_type_snapshot||entitlement.service_type||'jellyfin');
  if(!['jellyfin','bundle'].includes(service))throw new Error('This plan does not include Jellyfin access.');
  const target=await targetServer(targetServerId);
  if(!target)throw new Error('Choose an enabled Jellyfin server.');

  const accounts=await customerAccounts(customerId);
  const current=accounts.find(account=>!account.disabled&&account.is_primary)||accounts.find(account=>!account.disabled)||accounts[0]||null;
  if(!current)throw new Error('This customer has no Jellyfin account to move. Use Add to server instead.');

  const effective=await provisioning.effectivePolicyForCustomer(customerId,entitlement);
  const targetLibraries=await provisioning.resolveLibraryAccessForServer(target.id,effective.unrestricted,effective.visibleNames,false);
  if(targetLibraries.missing.length)throw new Error(`${target.name} is missing required libraries: ${targetLibraries.missing.join(', ')}.`);

  let targetAccount=accounts.find(account=>same(account.server_id,target.id))||null;
  let created=false;
  if(targetAccount){
    await provisioning.applyPolicy(targetAccount,effective,false);
    await query(`UPDATE jellyfin_accounts SET disabled=FALSE,password_setup_required=TRUE,password_reset_required=TRUE,updated_at=NOW() WHERE id=$1`,[targetAccount.id]);
    targetAccount={...targetAccount,disabled:false,password_setup_required:true,password_reset_required:true};
  }else{
    targetAccount=await provisioning.createJellyfinAccount(customerId,target,effective,{
      preferredUsername:current.jellyfin_username,
      requireExactUsername:true,
      makePrimary:false
    });
    created=true;
  }

  // Persist the target before touching the source. If a later source disable
  // fails, automation still converges toward the administrator-selected target
  // rather than silently placing the customer elsewhere.
  await adminControl.forceServer(customerId,entitlement.subscription_id,target.id,{actorUserId,reason:'Jellyfin server moved explicitly by administrator'});
  await provisioning.markPrimaryAccount(customerId,targetAccount.id);

  const disabled=[];
  for(const account of accounts){
    if(same(account.id,targetAccount.id)||account.disabled)continue;
    await provisioning.disableJellyfinAccount(account);
    disabled.push(account.id);
  }

  const assigned=await query(`SELECT COUNT(*)::int n FROM jellyfin_accounts WHERE server_id=$1 AND disabled=FALSE`,[target.id]);
  const activeUsers=Number(assigned.rows[0]?.n||0),maxUsers=Number(target.max_users||0)||null;
  await query(`
    INSERT INTO customer_provisioning_state(customer_id,status,consecutive_failures,last_error,last_attempt_at,last_success_at,next_attempt_at,subscription_id,plan_id,jellyfin_account_id,server_id,last_result,updated_at)
    VALUES($1,'healthy',0,NULL,NOW(),NOW(),NULL,$2,$3,$4,$5,$6::jsonb,NOW())
    ON CONFLICT(customer_id) DO UPDATE SET status='healthy',consecutive_failures=0,last_error=NULL,last_attempt_at=NOW(),last_success_at=NOW(),next_attempt_at=NULL,subscription_id=EXCLUDED.subscription_id,plan_id=EXCLUDED.plan_id,jellyfin_account_id=EXCLUDED.jellyfin_account_id,server_id=EXCLUDED.server_id,last_result=EXCLUDED.last_result,updated_at=NOW()
  `,[customerId,entitlement.subscription_id,entitlement.plan_id,targetAccount.id,target.id,JSON.stringify({adminForcedMove:true,targetServerId:target.id,targetServerName:target.name,createdTargetAccount:created,disabledSourceAccountIds:disabled,activeUsers,maxUsers,overCapacityBy:maxUsers?Math.max(0,activeUsers-maxUsers):0})]);
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.server_move.force','customer',$2,$3::jsonb)`,[actorUserId,customerId,JSON.stringify({subscriptionId:entitlement.subscription_id,fromServerId:current.server_id,toServerId:target.id,targetServerName:target.name,createdTargetAccount:created,disabledSourceAccountIds:disabled,activeUsers,maxUsers,capacityOverridden:Boolean(maxUsers&&activeUsers>maxUsers),planServerClass:entitlement.server_class,targetServerClass:target.server_class})]);
  return{target,targetAccount,created,disabledSourceAccountIds:disabled,activeUsers,maxUsers};
}

module.exports={move,targetServer,customerAccounts};
