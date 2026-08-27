'use strict';

const {query}=require('../db');
const accessHolds=require('./access-holds');
const subscriptionState=require('./subscription-state');
const CLEANUP_HOLD_TYPE='jellyfin_cleanup';
const INACTIVITY_HOLD_TYPE='inactivity_policy';

async function restoreReturningCustomer(customerId,{reconcile}={}){
  const [cleanupHolds,deletedLifecycle,freeEntitlement]=await Promise.all([
    query(`SELECT source_key FROM customer_access_holds WHERE customer_id=$1 AND hold_type=$2 AND released_at IS NULL ORDER BY created_at`,[customerId,CLEANUP_HOLD_TYPE]),
    query(`SELECT id,metadata FROM jellyfin_account_lifecycle WHERE customer_id=$1 AND category='free' AND deleted_at IS NOT NULL AND restored_at IS NULL ORDER BY deleted_at DESC`,[customerId]),
    subscriptionState.liveFreeJellyfinSubscription(customerId,{includeBlocked:true})
  ]);

  const inactivitySource=freeEntitlement?.plan_id?`plan:${freeEntitlement.plan_id}`:null;
  const inactivityHold=inactivitySource?await query(`SELECT source_key FROM customer_access_holds WHERE customer_id=$1 AND hold_type=$2 AND source_key=$3 AND released_at IS NULL LIMIT 1`,[customerId,INACTIVITY_HOLD_TYPE,inactivitySource]):{rowCount:0,rows:[]};
  const canRestoreDeletedFree=Boolean(deletedLifecycle.rowCount&&freeEntitlement&&inactivityHold.rowCount);
  if(!cleanupHolds.rowCount&&!canRestoreDeletedFree)return{restored:false};

  // Generic cleanup holds intentionally make normal entitlement lookup blocked.
  // Free inactivity deletion is lane-scoped, so use the current blocked Free
  // entitlement itself as the proof that this returning customer may be rebuilt.
  let genericEntitlement=null;
  if(cleanupHolds.rowCount){
    genericEntitlement=await subscriptionState.effectiveSubscription(customerId,{includeBlocked:true});
    const delivery=String(genericEntitlement?.service_type_snapshot||genericEntitlement?.service_type||'jellyfin');
    if(!genericEntitlement||!['jellyfin','bundle'].includes(delivery))return{restored:false,reason:'no_jellyfin_entitlement'};
  }

  for(const row of cleanupHolds.rows)await accessHolds.releaseHold({customerId,type:CLEANUP_HOLD_TYPE,sourceKey:row.source_key});
  if(canRestoreDeletedFree)await accessHolds.releaseHold({customerId,type:INACTIVITY_HOLD_TYPE,sourceKey:inactivitySource});

  if(typeof reconcile==='function')await reconcile(customerId);

  if(canRestoreDeletedFree){
    await query(`UPDATE jellyfin_account_lifecycle SET restored_at=NOW(),metadata=metadata||$2::jsonb,updated_at=NOW() WHERE customer_id=$1 AND category='free' AND deleted_at IS NOT NULL AND restored_at IS NULL`,[customerId,JSON.stringify({portalReturn:true,reprovisionedAfterDeletion:true})]);
  }
  await query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('jellyfin.cleanup.restore_on_portal_return','customer',$1,$2::jsonb)`,[customerId,JSON.stringify({releasedCleanupHolds:cleanupHolds.rowCount,releasedInactivityHold:canRestoreDeletedFree,portalReturn:true,freePlanId:freeEntitlement?.plan_id||null})]);
  return{restored:true,released:Number(cleanupHolds.rowCount)+Number(canRestoreDeletedFree),freeLifecycleRestored:canRestoreDeletedFree};
}
module.exports={CLEANUP_HOLD_TYPE,INACTIVITY_HOLD_TYPE,restoreReturningCustomer};
