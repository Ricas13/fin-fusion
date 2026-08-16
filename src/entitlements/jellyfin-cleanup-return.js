'use strict';

const {query}=require('../db');
const accessHolds=require('./access-holds');
const subscriptionState=require('./subscription-state');
const CLEANUP_HOLD_TYPE='jellyfin_cleanup';

async function restoreReturningCustomer(customerId,{reconcile}={}){
  const holds=await query(`SELECT source_key FROM customer_access_holds WHERE customer_id=$1 AND hold_type=$2 AND released_at IS NULL ORDER BY created_at`,[customerId,CLEANUP_HOLD_TYPE]);
  if(!holds.rowCount)return{restored:false};
  // Cleanup holds intentionally make normal entitlement lookup look blocked.
  // Portal return is the one explicit path allowed to inspect through that hold.
  const entitlement=await subscriptionState.effectiveSubscription(customerId,{includeBlocked:true});
  const delivery=String(entitlement?.service_type_snapshot||entitlement?.service_type||'jellyfin');
  if(!entitlement||!['jellyfin','bundle'].includes(delivery))return{restored:false,reason:'no_jellyfin_entitlement'};
  for(const row of holds.rows)await accessHolds.releaseHold({customerId,type:CLEANUP_HOLD_TYPE,sourceKey:row.source_key});
  if(typeof reconcile==='function')await reconcile(customerId);
  await query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('jellyfin.cleanup.restore_on_portal_return','customer',$1,$2::jsonb)`,[customerId,JSON.stringify({releasedCleanupHolds:holds.rowCount,portalReturn:true})]);
  return{restored:true,released:holds.rowCount};
}
module.exports={CLEANUP_HOLD_TYPE,restoreReturningCustomer};
