'use strict';

const {query}=require('../db');
const core=require('./provisioning-helpers');
const subscriptionState=require('../entitlements/subscription-state');
const serviceCatalog=require('../catalog/service-catalog');
const planServers=require('./plan-servers');
const placement=require('./placement');
const userCapacity=require('./user-capacity');
const customerServerChoice=require('./customer-server-choice');

function normalizeService(value){
  const type=serviceCatalog.serviceType(value);
  if(!['jellyfin','emby'].includes(type))throw new Error(`Unsupported media service lane: ${type}`);
  return type;
}
function remoteMissing(error){return Number(error?.status||0)===404||/\b404\b|not found|not\s+exist/i.test(String(error?.message||error||''));}

async function entitlementFor(customerId,serviceType,{includeBlocked=false}={}){
  const type=normalizeService(serviceType);
  return type==='emby'
    ? subscriptionState.effectiveEmbySubscription(customerId,{includeBlocked})
    : subscriptionState.effectiveSubscription(customerId,{includeBlocked});
}

async function accountsFor(customerId,serviceType){
  const type=normalizeService(serviceType);
  const result=await query(`
    SELECT ja.*,js.enabled AS server_enabled,js.server_class,
           COALESCE(js.media_server_type,'jellyfin') AS media_server_type,
           js.public_url,js.name AS server_name,js.location AS server_location
    FROM jellyfin_accounts ja
    JOIN jellyfin_servers js ON js.id=ja.server_id
    WHERE ja.customer_id=$1
      AND ja.account_purpose='jellyfin'
      AND COALESCE(js.media_server_type,'jellyfin')=$2
    ORDER BY ja.is_primary DESC,ja.disabled ASC,ja.created_at ASC
  `,[customerId,type]);
  return result.rows;
}

function accessKind(plan){
  if(String(plan?.billing_interval||plan?.contract_billing_interval||'').toLowerCase()==='trial')return'trial';
  return Number(plan?.price_minor??plan?.contract_price_minor??0)===0?'free':'paid';
}

async function selectServerForPlan(plan){
  const type=normalizeService(plan);
  const assigned=await customerServerChoice.assignedServer(plan,type);
  if(assigned)return{...assigned,placement_assigned:true};
  const kind=accessKind(plan);
  const available=(await planServers.eligibleServersForPlan(plan,{enabledOnly:true,forPlacement:true}))
    .filter(server=>customerServerChoice.matchesPreference(server,plan?.media_location_preference||null))
    .filter(server=>normalizeService(server.media_server_type||type)===type)
    .filter(server=>Boolean(server.allow_new_users))
    .filter(server=>kind==='trial'?Boolean(server.trial_enabled):kind==='paid'?Boolean(server.paid_enabled):true);
  if(!available.length)return null;

  const candidates=await userCapacity.decorateServers(available);
  const ids=candidates.map(server=>server.id);
  const usage=ids.length?await query(`
    SELECT server_id,COUNT(DISTINCT jellyfin_session_id)::int AS active_streams
    FROM active_playback_sessions
    WHERE server_id=ANY($1::uuid[])
    GROUP BY server_id
  `,[ids]):{rows:[]};
  const streams=new Map(usage.rows.map(row=>[String(row.server_id),Number(row.active_streams||0)]));
  for(const server of candidates)server.active_streams=streams.get(String(server.id))||0;
  return placement.selectServer(candidates,plan.placement_strategy);
}

async function recordRun(customerId,subscriptionId,action,fn){
  const started=await query(`
    INSERT INTO provisioning_runs(customer_id,subscription_id,action,status)
    VALUES($1,$2,$3,'started') RETURNING id
  `,[customerId,subscriptionId||null,action]);
  const id=started.rows[0].id;
  try{
    const value=await fn();
    await query(`UPDATE provisioning_runs SET status='succeeded',completed_at=NOW() WHERE id=$1`,[id]);
    return value;
  }catch(error){
    await query(`UPDATE provisioning_runs SET status='failed',detail=$2::jsonb,completed_at=NOW() WHERE id=$1`,[id,JSON.stringify({error:error.message,serviceType:action.split('_')[0]})]);
    throw error;
  }
}

async function markPasswordSetupRequired(account){
  if(!account?.id)return account;
  await query(`
    UPDATE jellyfin_accounts
    SET password_setup_required=TRUE,password_reset_required=TRUE,updated_at=NOW()
    WHERE id=$1
  `,[account.id]);
  account.password_setup_required=true;
  account.password_reset_required=true;
  return account;
}

async function createForEntitlement(customerId,type,entitlement,effective){
  const server=await selectServerForPlan(entitlement);
  if(!server)throw new Error(`No eligible ${serviceCatalog.label(type)} server is currently available for plan ${entitlement.contract_plan_code||entitlement.code}`);
  const account=await core.createJellyfinAccount(customerId,server,effective,{makePrimary:type==='jellyfin'});
  await customerServerChoice.persistAssignment(entitlement.subscription_id,server,{overwrite:Boolean(entitlement.admin_forced_server_id)});
  entitlement.media_server_id=server.id;
  entitlement.media_location_snapshot=customerServerChoice.locationLabel(server.location);
  if(type==='emby')await markPasswordSetupRequired(account);
  account.media_server_type=type;
  account.public_url=server.public_url||null;
  account.server_name=server.name||null;
  return account;
}

async function recoverMissingAccount(customerId,type,account,entitlement,effective){
  const stale={id:account.id,serverId:account.server_id,remoteUserId:account.jellyfin_user_id,username:account.jellyfin_username};
  await core.deleteJellyfinAccount(account,{reason:`Remote ${serviceCatalog.label(type)} account was already missing during reconciliation`});
  // This object may still be present in the caller's pre-recovery account list.
  // Mark it retired in memory so the same reconciliation pass cannot try to
  // disable/delete the already-removed identity a second time.
  account.disabled=true;
  account.server_enabled=false;
  const replacement=await createForEntitlement(customerId,type,entitlement,effective);
  await query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata)
               VALUES('media.remote_missing.recreated','customer',$1,$2::jsonb)`,[
    customerId,
    JSON.stringify({serviceType:type,oldAccountId:stale.id,oldServerId:stale.serverId,oldRemoteUserId:stale.remoteUserId,oldUsername:stale.username,newAccountId:replacement.id,newServerId:replacement.server_id,newRemoteUserId:replacement.jellyfin_user_id,newUsername:replacement.jellyfin_username})
  ]);
  return replacement;
}

async function reconcileCustomer(customerId,serviceType){
  const type=normalizeService(serviceType);
  const entitlement=await entitlementFor(customerId,type);
  return recordRun(customerId,entitlement?.subscription_id||null,`${type}_${entitlement?'reconcile':'disable'}`,async()=>{
    const accounts=await accountsFor(customerId,type);
    if(!entitlement){
      for(const account of accounts){
        if(!account.disabled&&account.server_enabled)await core.disableJellyfinAccount(account);
      }
      return{active:false,disabled:accounts.length,serviceType:type,entitlement:null};
    }

    if(!entitlement.media_server_id&&!entitlement.admin_forced_server_id){
      const existing=accounts.find(account=>!account.disabled&&account.server_enabled)||accounts.find(account=>account.server_enabled)||accounts[0];
      if(existing){
        await customerServerChoice.persistAssignment(entitlement.subscription_id,existing);
        entitlement.media_server_id=existing.server_id;
        entitlement.media_location_snapshot=customerServerChoice.locationLabel(existing.server_location);
      }
    }
    const effective=await core.effectivePolicyForCustomer(customerId,entitlement);
    const entitledServers=entitlement.media_server_id?[]:(await planServers.eligibleServersForPlan(entitlement,{enabledOnly:false,forPlacement:false}))
      .filter(server=>normalizeService(server.media_server_type||type)===type);
    const entitledServerIds=new Set(entitledServers.map(server=>String(server.id)));
    const matchesPlacement=account=>account.server_enabled&&(entitlement.media_server_id?String(account.server_id)===String(entitlement.media_server_id):entitledServerIds.has(String(account.server_id)));
    let account=type==='jellyfin'
      ? accounts.find(a=>a.is_primary&&matchesPlacement(a))
      : null;
    if(!account)account=accounts.find(a=>!a.disabled&&matchesPlacement(a));
    if(!account)account=accounts.find(a=>matchesPlacement(a));
    let created=false;

    if(!account){
      account=await createForEntitlement(customerId,type,entitlement,effective);
      created=true;
    }else{
      try{
        await core.applyPolicy(account,effective,false);
      }catch(error){
        if(!remoteMissing(error))throw error;
        account=await recoverMissingAccount(customerId,type,account,entitlement,effective);
        created=true;
      }
      if(type==='jellyfin'&&!account.is_primary){
        await core.markPrimaryAccount(customerId,account.id);
        account.is_primary=true;
      }
    }

    for(const old of accounts){
      if(old.id!==account.id&&!old.disabled&&old.server_enabled)await core.disableJellyfinAccount(old);
    }

    await query(`
      INSERT INTO audit_log(action,entity_type,entity_id,metadata)
      VALUES('entitlement.reconcile','customer',$1,$2::jsonb)
    `,[customerId,JSON.stringify({
      serviceType:type,
      subscriptionId:entitlement.subscription_id,
      planCode:entitlement.contract_plan_code||entitlement.code,
      serverId:account.server_id,
      mediaAccountId:account.id,
      created,
      effectiveStreams:effective.technical.streams,
      libraryVisibleCount:effective.visibleNames.length,
      placementStrategy:placement.normalizeStrategy(entitlement.placement_strategy)
    })]);

    return{active:true,entitlement,account,effective,serviceType:type,created};
  });
}

async function reconcileAll(customerId){
  const jellyfin=await reconcileCustomer(customerId,'jellyfin');
  const emby=await reconcileCustomer(customerId,'emby');
  return{jellyfin,emby};
}

async function reconcileAccount(accountId){
  const found=await query(`
    SELECT ja.*,COALESCE(js.media_server_type,'jellyfin') AS media_server_type,
           js.enabled AS server_enabled
    FROM jellyfin_accounts ja
    JOIN jellyfin_servers js ON js.id=ja.server_id
    WHERE ja.id=$1
  `,[accountId]);
  if(!found.rowCount)throw new Error('Media server account not found');
  const account=found.rows[0];
  const type=normalizeService(account.media_server_type);
  const entitlement=await entitlementFor(account.customer_id,type);
  if(!entitlement||!account.server_enabled)return core.disableJellyfinAccount(account);
  const effective=await core.effectivePolicyForCustomer(account.customer_id,entitlement);
  try{return await core.applyPolicy(account,effective,false);}
  catch(error){
    if(!remoteMissing(error))throw error;
    return recoverMissingAccount(account.customer_id,type,account,entitlement,effective);
  }
}

module.exports={normalizeService,remoteMissing,entitlementFor,accountsFor,selectServerForPlan,reconcileCustomer,reconcileAll,reconcileAccount,markPasswordSetupRequired,createForEntitlement,recoverMissingAccount};
