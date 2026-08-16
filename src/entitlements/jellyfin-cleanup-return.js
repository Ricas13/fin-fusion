'use strict';

const {query}=require('../db');
const accessHolds=require('./access-holds');
const subscriptionState=require('./subscription-state');
const CLEANUP_HOLD_TYPE='jellyfin_cleanup';
const FREE_HOLD_TYPE='inactivity_policy';

async function restoreReturningCustomer(customerId,{reconcile}={}){
  const holds=await query(`SELECT hold_type,source_key FROM customer_access_holds WHERE customer_id=$1 AND hold_type=ANY($2::text[]) AND released_at IS NULL ORDER BY created_at`,[customerId,[CLEANUP_HOLD_TYPE,FREE_HOLD_TYPE]]);
  if(!holds.rowCount)return{restored:false};
  // These Jellyfin-only holds deliberately make normal entitlement lookup look
  // blocked. Portal return may inspect through them, but it never changes the
  // CAPTaINFiN customer/app-user identity itself.
  const entitlement=await subscriptionState.effectiveSubscription(customerId,{includeBlocked:true});
  const delivery=String(entitlement?.service_type_snapshot||entitlement?.service_type||'jellyfin');
  if(!entitlement||!['jellyfin','bundle'].includes(delivery))return{restored:false,reason:'no_jellyfin_entitlement'};
  for(const row of holds.rows)await accessHolds.releaseHold({customerId,type:row.hold_type,sourceKey:row.source_key});
  if(typeof reconcile==='function')await reconcile(customerId);
  await query(`UPDATE jellyfin_account_lifecycle SET recovered_at=COALESCE(recovered_at,NOW()),updated_at=NOW(),metadata=metadata||'{"portalReturn":true}'::jsonb WHERE customer_id=$1 AND recovered_at IS NULL AND deleted_at IS NULL`,[customerId]).catch(()=>{});
  await query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('jellyfin.lifecycle.restore_on_portal_return','customer',$1,$2::jsonb)`,[customerId,JSON.stringify({releasedHolds:holds.rowCount,portalReturn:true,portalAccountPreserved:true})]);
  return{restored:true,released:holds.rowCount};
}
module.exports={CLEANUP_HOLD_TYPE,FREE_HOLD_TYPE,restoreReturningCustomer};
