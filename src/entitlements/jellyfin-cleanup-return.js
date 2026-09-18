'use strict';

const {query}=require('../db');
const accessHolds=require('./access-holds');
const subscriptionState=require('./subscription-state');
const subscriptionTermination=require('../payments/subscription-termination');
const inactivityRestore=require('./jellyfin-inactivity-restore');
const CLEANUP_HOLD_TYPE='jellyfin_cleanup';
const INACTIVITY_HOLD_TYPE='inactivity_policy';

async function returningCustomerStatus(customerId){
  const [cleanupHolds,freeEntitlement]=await Promise.all([
    query(`SELECT source_key FROM customer_access_holds WHERE customer_id=$1 AND hold_type=$2 AND released_at IS NULL ORDER BY created_at`,[customerId,CLEANUP_HOLD_TYPE]),
    subscriptionState.liveFreeJellyfinSubscription(customerId,{includeBlocked:true})
  ]);

  const inactivitySource=freeEntitlement?.plan_id?`plan:${freeEntitlement.plan_id}`:null;
  const inactivityHold=inactivitySource?await query(`SELECT source_key FROM customer_access_holds WHERE customer_id=$1 AND hold_type=$2 AND source_key=$3 AND released_at IS NULL LIMIT 1`,[customerId,INACTIVITY_HOLD_TYPE,inactivitySource]):{rowCount:0,rows:[]};

  // The binary present-or-deleted lifecycle retired jellyfin_account_lifecycle
  // as the authority for current Free removal episodes. The active inactivity
  // hold is now the durable source of truth: active Free entitlement + matching
  // inactivity hold means the user is eligible to explicitly restore access.
  const canRestoreDeletedFree=Boolean(freeEntitlement&&inactivityHold.rowCount);
  const cleanupSources=cleanupHolds.rows.map(row=>row.source_key);
  if(!cleanupSources.length&&!canRestoreDeletedFree){
    return{eligible:false,cleanupSources:[],canRestoreDeletedFree:false,inactivitySource:null,freePlanId:freeEntitlement?.plan_id||null,freeSubscriptionId:freeEntitlement?.subscription_id||null};
  }

  // Generic cleanup holds intentionally make normal entitlement lookup blocked.
  // Inspection is read-only: GET /account may call this helper to decide whether
  // to offer recovery, but it must not release holds or contact Jellyfin.
  if(cleanupSources.length){
    const genericEntitlement=await subscriptionState.effectiveSubscription(customerId,{includeBlocked:true});
    const delivery=String(genericEntitlement?.service_type_snapshot||genericEntitlement?.service_type||'jellyfin');
    if(!genericEntitlement||!['jellyfin','bundle'].includes(delivery)){
      return{eligible:false,reason:'no_jellyfin_entitlement',cleanupSources,canRestoreDeletedFree,inactivitySource,freePlanId:freeEntitlement?.plan_id||null,freeSubscriptionId:freeEntitlement?.subscription_id||null};
    }
  }

  return{
    eligible:true,
    cleanupSources,
    canRestoreDeletedFree,
    inactivitySource,
    freePlanId:freeEntitlement?.plan_id||null,
    freeSubscriptionId:freeEntitlement?.subscription_id||null
  };
}

async function declineDeletedFreeAccess(customerId,{actorUserId=null}={}){
  const status=await returningCustomerStatus(customerId);
  if(!status.canRestoreDeletedFree||!status.freeSubscriptionId){
    return{removed:false,reason:'no_restorable_free_access'};
  }

  const reason='Customer declined Free Access restoration after inactivity';
  await subscriptionTermination.terminateLocal(status.freeSubscriptionId,customerId,{
    actorUserId,
    reason,
    reference:`free-access-inactivity-decline:${status.freeSubscriptionId}`
  });
  const released=await accessHolds.releaseHold({
    customerId,
    type:INACTIVITY_HOLD_TYPE,
    sourceKey:status.inactivitySource,
    actorUserId,
    resolutionReason:reason
  });
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'jellyfin.cleanup.decline_free_restore','customer',$2,$3::jsonb)`,[
    actorUserId,
    customerId,
    JSON.stringify({subscriptionId:status.freeSubscriptionId,freePlanId:status.freePlanId,releasedInactivityHold:Boolean(released),portalReturn:true,explicitDecline:true})
  ]);
  return{removed:true,subscriptionId:status.freeSubscriptionId,freePlanId:status.freePlanId,releasedInactivityHold:Boolean(released)};
}

async function restoreReturningCustomer(customerId,{reconcile}={}){
  const status=await returningCustomerStatus(customerId);
  if(!status.eligible)return{restored:false,reason:status.reason||null};

  // Generic cleanup holds are separate from Free inactivity. Release them
  // because the customer explicitly requested restoration.
  for(const sourceKey of status.cleanupSources){
    await accessHolds.releaseHold({
      customerId,
      type:CLEANUP_HOLD_TYPE,
      sourceKey,
      resolutionReason:'Customer explicitly requested access restoration'
    });
  }

  let freeRestore=null;
  try{
    if(status.canRestoreDeletedFree){
      // One canonical inactivity restoration path: release the exact hold,
      // reprovision, restore the hold on failure, and verify one Free account.
      freeRestore=await inactivityRestore.restoreDisabledFreeAccess(customerId,{reconcile});
    }else if(typeof reconcile==='function'){
      await reconcile(customerId);
    }
  }catch(error){
    await query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('jellyfin.cleanup.restore_on_portal_return','customer',$1,$2::jsonb)`,[
      customerId,
      JSON.stringify({
        releasedCleanupHolds:status.cleanupSources.length,
        releasedInactivityHold:false,
        portalReturn:true,
        explicitRestore:true,
        freePlanId:status.freePlanId,
        reprovisionPending:true,
        error:String(error?.message||error).slice(0,500)
      })
    ]).catch(()=>{});
    throw error;
  }

  await query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('jellyfin.cleanup.restore_on_portal_return','customer',$1,$2::jsonb)`,[
    customerId,
    JSON.stringify({
      releasedCleanupHolds:status.cleanupSources.length,
      releasedInactivityHold:Boolean(freeRestore?.restored),
      portalReturn:true,
      explicitRestore:true,
      freePlanId:status.freePlanId,
      reprovisionPending:false
    })
  ]);

  return{
    restored:true,
    released:Number(status.cleanupSources.length)+Number(Boolean(freeRestore?.restored)),
    freeLifecycleRestored:Boolean(freeRestore?.restored)
  };
}
module.exports={CLEANUP_HOLD_TYPE,INACTIVITY_HOLD_TYPE,returningCustomerStatus,declineDeletedFreeAccess,restoreReturningCustomer};
