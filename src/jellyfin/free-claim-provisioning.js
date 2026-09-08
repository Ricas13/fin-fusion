'use strict';

const {query}=require('../db');
const provisioning=require('./resilient-provisioning');
const control=require('./reconciliation-control');

async function hasFreeAccount(customerId){
  const result=await query(`
    SELECT 1
    FROM jellyfin_accounts ja
    JOIN jellyfin_servers js ON js.id=ja.server_id
    WHERE ja.customer_id=$1
      AND ja.account_purpose='jellyfin'
      AND ja.access_lane='free'
      AND ja.disabled=FALSE
      AND js.enabled=TRUE
      AND COALESCE(js.media_server_type,'jellyfin')='jellyfin'
    LIMIT 1
  `,[customerId]);
  return result.rowCount>0;
}

async function ensureFreeClaimProvisioned(customerId,{attempts=2}={}){
  const maxAttempts=Math.max(1,Math.min(3,Number(attempts)||1));
  await control.forceCustomerDue(customerId);
  let lastError=null;
  for(let attempt=1;attempt<=maxAttempts;attempt+=1){
    try{
      await provisioning.reconcileCustomer(customerId);
      if(await hasFreeAccount(customerId))return{ready:true,attempts:attempt,error:null};
      lastError=new Error('Free Server entitlement reconciled without creating an enabled Free Server account.');
      lastError.code='FREE_CLAIM_ACCOUNT_MISSING';
    }catch(error){lastError=error;}
  }
  // Keep the customer durably due even if the normal reconciler classified the
  // failure as blocked/failed with a later retry. The dedicated Free claim
  // repair job will pick it up on its next short cycle.
  await control.forceCustomerDue(customerId).catch(()=>{});
  return{ready:false,attempts:maxAttempts,error:lastError};
}

async function pendingFreeClaims(limit=100){
  const bounded=Math.max(1,Math.min(500,Number(limit)||100));
  const result=await query(`
    SELECT DISTINCT ON (s.customer_id)
      s.customer_id,s.id subscription_id,s.plan_id,s.created_at
    FROM subscriptions s
    JOIN plans p ON p.id=s.plan_id
    JOIN customers c ON c.id=s.customer_id
    WHERE s.superseded_by IS NULL
      AND s.starts_at<=NOW()
      AND s.status IN('active','trialing','past_due','paused')
      AND s.current_period_end>NOW()
      AND p.is_free_tier=TRUE
      AND COALESCE(p.price_minor,0)=0
      AND COALESCE(p.is_addon,FALSE)=FALSE
      AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN('jellyfin','bundle')
      AND c.access_paused_at IS NULL
      AND NOT EXISTS(
        SELECT 1 FROM customer_bans b
        WHERE b.customer_id=s.customer_id
          AND b.revoked_at IS NULL
          AND b.blocks_service_access=TRUE
      )
      AND NOT EXISTS(
        SELECT 1 FROM customer_access_holds h
        WHERE h.customer_id=s.customer_id
          AND h.released_at IS NULL
          AND h.hold_type IN('inactivity_policy','jellyfin_cleanup')
          AND (h.source_key=('plan:'||s.plan_id::text) OR h.source_key IS NULL)
      )
      AND NOT EXISTS(
        SELECT 1
        FROM jellyfin_accounts ja
        JOIN jellyfin_servers js ON js.id=ja.server_id
        WHERE ja.customer_id=s.customer_id
          AND ja.account_purpose='jellyfin'
          AND ja.access_lane='free'
          AND ja.disabled=FALSE
          AND js.enabled=TRUE
          AND COALESCE(js.media_server_type,'jellyfin')='jellyfin'
      )
    ORDER BY s.customer_id,s.created_at DESC
    LIMIT $1
  `,[bounded]);
  return result.rows;
}

async function repairPendingFreeClaims({limit=100}={}){
  const rows=await pendingFreeClaims(limit);
  let succeeded=0,failed=0;
  const failures=[];
  for(const row of rows){
    const result=await ensureFreeClaimProvisioned(row.customer_id,{attempts:1});
    if(result.ready)succeeded+=1;
    else{
      failed+=1;
      failures.push({customerId:row.customer_id,error:String(result.error?.message||result.error||'Unknown Free claim provisioning failure').slice(0,300)});
    }
  }
  return{total:rows.length,processed:rows.length,succeeded,failed,failures:failures.slice(0,10)};
}

module.exports={hasFreeAccount,ensureFreeClaimProvisioned,pendingFreeClaims,repairPendingFreeClaims};
