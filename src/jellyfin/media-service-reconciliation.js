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

function unambiguousLegacyAccount(accounts, label = 'media') {
  const rows=Array.isArray(accounts)?accounts:[];
  if(!rows.length)return null;
  const ready=rows.filter(account=>!account.disabled&&account.server_enabled);
  if(ready.length===1)return ready[0];
  if(ready.length>1){
    const error=new Error(`Multiple enabled legacy ${label} accounts exist without a persisted server assignment. Administrator repair is required before reconciliation can choose a server safely.`);
    error.code='AMBIGUOUS_LEGACY_MEDIA_ASSIGNMENT';
    throw error;
  }
  const reachable=rows.filter(account=>account.server_enabled);
  if(reachable.length===1)return reachable[0];
  if(reachable.length>1||rows.length>1){
    const error=new Error(`Multiple legacy ${label} accounts exist without a persisted server assignment. Administrator repair is required before reconciliation can choose a server safely.`);
    error.code='AMBIGUOUS_LEGACY_MEDIA_ASSIGNMENT';
    throw error;
  }
  return rows[0];
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

  // Crash recovery must stay on the server that already owns an in-flight
  // creation/placement reservation. Otherwise a remote create that succeeded
  // before local persistence could be retried on a different server and create
  // a duplicate paid media identity.
  let recoveryServer=await core.reservedServerForCustomer(plan?.customer_id||null,available,'primary');
  if(!recoveryServer&&type==='emby'&&plan?.customer_id){
    // Rolling-deploy compatibility: older Emby intents/leases predate
    // access_lane. Because the candidate set is Emby-only, a lane-less
    // reservation here is unambiguously the Emby primary lane.
    const ids=available.map(server=>server.id);
    const legacy=ids.length?await query(`
      WITH reservations AS (
        SELECT server_id,0 AS kind_rank,updated_at
        FROM jellyfin_account_creation_intents
        WHERE customer_id=$1 AND server_id=ANY($2::uuid[]) AND access_lane IS NULL
        UNION ALL
        SELECT server_id,1 AS kind_rank,updated_at
        FROM jellyfin_server_placement_leases
        WHERE customer_id=$1 AND server_id=ANY($2::uuid[])
          AND access_lane IS NULL AND expires_at>NOW()
      )
      SELECT server_id
      FROM reservations
      ORDER BY kind_rank ASC,updated_at DESC
      LIMIT 1
    `,[plan.customer_id,ids]):{rows:[]};
    const row=legacy.rows[0];
    const server=row?available.find(candidate=>String(candidate.id)===String(row.server_id)):null;
    if(server)recoveryServer={...server,requested_access_lane:'primary',placement_recovery:true};
  }
  if(recoveryServer)return recoveryServer;

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

async function createForEntitlement(customerId,type,entitlement,_effective=null){
  const server=await selectServerForPlan(entitlement);
  if(!server)throw new Error(`No eligible ${serviceCatalog.label(type)} server is currently available for plan ${entitlement.contract_plan_code||entitlement.code}`);
  const effective=await core.effectivePolicyForCustomer(customerId,entitlement,null,{serverId:server.id});
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
    if(!entitlement||entitlement.blocked){
      for(const account of accounts){
        if(!account.disabled&&account.server_enabled)await core.disableJellyfinAccount(account);
      }
      return{
        active:false,
        blocked:Boolean(entitlement?.blocked),
        disabled:accounts.length,
        serviceType:type,
        entitlement:entitlement||null
      };
    }

    if(!entitlement.media_server_id&&!entitlement.admin_forced_server_id){
      const existing=unambiguousLegacyAccount(accounts,`${serviceCatalog.label(type)}`);
      if(existing){
        await customerServerChoice.persistAssignment(entitlement.subscription_id,existing);
        entitlement.media_server_id=existing.server_id;
        entitlement.media_location_snapshot=customerServerChoice.locationLabel(existing.server_location);
      }
    }
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
    let effective=null;

    if(!account){
      account=await createForEntitlement(customerId,type,entitlement);
      effective=await core.effectivePolicyForCustomer(customerId,entitlement,null,{serverId:account.server_id});
      created=true;
    }else{
      effective=await core.effectivePolicyForCustomer(customerId,entitlement,null,{serverId:account.server_id});
      try{
        await core.applyPolicy(account,effective,false);
      }catch(error){
        if(!remoteMissing(error))throw error;
        account=await recoverMissingAccount(customerId,type,account,entitlement,effective);
        effective=await core.effectivePolicyForCustomer(customerId,entitlement,null,{serverId:account.server_id});
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
  if(!entitlement||entitlement.blocked||!account.server_enabled)return core.disableJellyfinAccount(account);
  const effective=await core.effectivePolicyForCustomer(account.customer_id,entitlement,null,{serverId:account.server_id});
  try{return await core.applyPolicy(account,effective,false);}
  catch(error){
    if(!remoteMissing(error))throw error;
    return recoverMissingAccount(account.customer_id,type,account,entitlement,effective);
  }
}

module.exports={normalizeService,remoteMissing,unambiguousLegacyAccount,entitlementFor,accountsFor,selectServerForPlan,reconcileCustomer,reconcileAll,reconcileAccount,markPasswordSetupRequired,createForEntitlement,recoverMissingAccount};
