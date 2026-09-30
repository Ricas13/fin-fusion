'use strict';

const {query}=require('../db');
const accessHolds=require('./access-holds');
const subscriptionState=require('./subscription-state');

const CLEANUP_HOLD_TYPE='jellyfin_cleanup';

function emptyStatus(extra={}){
  return{
    eligible:false,
    cleanupSources:[],
    canRestoreDeletedFree:false,
    inactivitySource:null,
    freePlanId:null,
    freeSubscriptionId:null,
    ...extra
  };
}

async function returningCustomerStatus(customerId){
  const cleanupHolds=await query(
    `SELECT source_key
     FROM customer_access_holds
     WHERE customer_id=$1
       AND hold_type=$2
       AND released_at IS NULL
     ORDER BY created_at`,
    [customerId,CLEANUP_HOLD_TYPE]
  );
  const cleanupSources=cleanupHolds.rows.map(row=>row.source_key);

  // Free Server inactivity is terminal: once that policy removes access, the
  // Free subscription is ended and is never surfaced here as restorable.
  // This flow now exists only for a live Jellyfin/bundle plan whose media
  // profile was cleaned up for a non-Free lifecycle reason.
  if(!cleanupSources.length)return emptyStatus();

  const entitlement=await subscriptionState.effectiveSubscription(customerId,{includeBlocked:true});
  const delivery=String(entitlement?.service_type_snapshot||entitlement?.service_type||'jellyfin');
  if(!entitlement||!['jellyfin','bundle'].includes(delivery)){
    return emptyStatus({
      cleanupSources,
      reason:'no_jellyfin_entitlement'
    });
  }

  return{
    eligible:true,
    cleanupSources,
    canRestoreDeletedFree:false,
    inactivitySource:null,
    freePlanId:null,
    freeSubscriptionId:null
  };
}

async function restoreReturningCustomer(customerId,{reconcile}={}){
  const status=await returningCustomerStatus(customerId);
  if(!status.eligible)return{restored:false,reason:status.reason||null};

  for(const sourceKey of status.cleanupSources){
    await accessHolds.releaseHold({
      customerId,
      type:CLEANUP_HOLD_TYPE,
      sourceKey,
      resolutionReason:'Customer explicitly requested access restoration'
    });
  }

  try{
    if(typeof reconcile==='function')await reconcile(customerId);
  }catch(error){
    await query(
      `INSERT INTO audit_log(action,entity_type,entity_id,metadata)
       VALUES('jellyfin.cleanup.restore_on_portal_return','customer',$1,$2::jsonb)`,
      [
        customerId,
        JSON.stringify({
          releasedCleanupHolds:status.cleanupSources.length,
          portalReturn:true,
          explicitRestore:true,
          reprovisionPending:true,
          error:String(error?.message||error).slice(0,500)
        })
      ]
    ).catch(()=>{});
    throw error;
  }

  await query(
    `INSERT INTO audit_log(action,entity_type,entity_id,metadata)
     VALUES('jellyfin.cleanup.restore_on_portal_return','customer',$1,$2::jsonb)`,
    [
      customerId,
      JSON.stringify({
        releasedCleanupHolds:status.cleanupSources.length,
        portalReturn:true,
        explicitRestore:true,
        reprovisionPending:false
      })
    ]
  );

  return{
    restored:true,
    released:Number(status.cleanupSources.length),
    freeLifecycleRestored:false
  };
}

module.exports={
  CLEANUP_HOLD_TYPE,
  returningCustomerStatus,
  restoreReturningCustomer
};
