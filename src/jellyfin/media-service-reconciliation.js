'use strict';

const {query}=require('../db');
const core=require('./provisioning');
const subscriptionState=require('../entitlements/subscription-state');
const serviceCatalog=require('../catalog/service-catalog');
const planServers=require('./plan-servers');
const placement=require('./placement');

function normalizeService(value){
  const type=serviceCatalog.serviceType(value);
  if(!['jellyfin','emby'].includes(type))throw new Error(`Unsupported media service lane: ${type}`);
  return type;
}

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
           js.public_url,js.name AS server_name
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
  const kind=accessKind(plan);
  const available=(await planServers.eligibleServersForPlan(plan,{enabledOnly:true,forPlacement:true}))
    .filter(server=>normalizeService(server.media_server_type||type)===type)
    .filter(server=>Boolean(server.allow_new_users))
    .filter(server=>kind==='trial'?Boolean(server.trial_enabled):kind==='paid'?Boolean(server.paid_enabled):true);
  if(!available.length)return null;

  const ids=available.map(server=>server.id);
  const usage=await query(`
    SELECT js.id,
           COUNT(DISTINCT ja.id)::int AS assigned_users,
           COUNT(DISTINCT aps.jellyfin_session_id)::int AS active_streams
    FROM jellyfin_servers js
    LEFT JOIN jellyfin_accounts ja ON ja.server_id=js.id AND ja.disabled=FALSE
    LEFT JOIN active_playback_sessions aps ON aps.server_id=js.id
    WHERE js.id=ANY($1::uuid[])
    GROUP BY js.id
  `,[ids]);
  const counts=new Map(usage.rows.map(row=>[String(row.id),row]));
  const candidates=available.map(server=>({
    ...server,
    assigned_users:Number(counts.get(String(server.id))?.assigned_users||0),
    active_streams:Number(counts.get(String(server.id))?.active_streams||0)
  })).filter(server=>server.max_users==null||Number(server.max_users)===0||server.assigned_users<Number(server.max_users));
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

    const effective=await core.effectivePolicyForCustomer(customerId,entitlement);
    let account=type==='jellyfin'
      ? accounts.find(a=>a.is_primary&&a.server_class===entitlement.server_class&&a.server_enabled)
      : null;
    if(!account)account=accounts.find(a=>!a.disabled&&a.server_class===entitlement.server_class&&a.server_enabled);
    if(!account)account=accounts.find(a=>a.server_class===entitlement.server_class&&a.server_enabled);
    let created=false;

    if(!account){
      const server=await selectServerForPlan(entitlement);
      if(!server)throw new Error(`No eligible ${serviceCatalog.label(type)} server is currently available for plan ${entitlement.contract_plan_code||entitlement.code}`);
      account=await core.createJellyfinAccount(customerId,server,effective,{makePrimary:type==='jellyfin'});
      created=true;
      if(type==='emby')await markPasswordSetupRequired(account);
      account.media_server_type=type;
      account.public_url=server.public_url||null;
      account.server_name=server.name||null;
    }else{
      await core.applyPolicy(account,effective,false);
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
  return core.applyPolicy(account,effective,false);
}

module.exports={normalizeService,entitlementFor,accountsFor,selectServerForPlan,reconcileCustomer,reconcileAll,reconcileAccount,markPasswordSetupRequired};
