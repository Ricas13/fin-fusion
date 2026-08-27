'use strict';

const {query}=require('../db');
const accessHolds=require('./access-holds');
const planPolicy=require('./plan-lifecycle-policy');
const lifecyclePolicy=require('./jellyfin-lifecycle-policy');
const HOLD_TYPE='inactivity_policy';

async function releaseObsoleteForCustomer(customerId,actorUserId=null){
  const holds=await query(`
    SELECT h.source_key,p.id plan_id,p.is_free_tier,p.price_minor,p.billing_interval,p.service_type,p.inactivity_policy,
           EXISTS(
             SELECT 1 FROM subscriptions s
             WHERE s.customer_id=h.customer_id AND s.plan_id=p.id AND s.superseded_by IS NULL
               AND s.status IN('active','trialing','past_due','paused') AND s.starts_at<=NOW() AND s.current_period_end>NOW()
           ) active_subscription
    FROM customer_access_holds h
    LEFT JOIN plans p ON h.source_key=('plan:'||p.id::text)
    WHERE h.customer_id=$1 AND h.hold_type=$2 AND h.released_at IS NULL
  `,[customerId,HOLD_TYPE]);
  if(!holds.rowCount)return 0;

  const globalCfg=await lifecyclePolicy.get();
  let released=0;
  for(const hold of holds.rows){
    const effective=planPolicy.effectiveForFreePlan(hold.inactivity_policy||{},globalCfg);
    const applies=Boolean(
      hold.plan_id&&hold.active_subscription&&hold.is_free_tier===true&&Number(hold.price_minor||0)===0&&
      String(hold.billing_interval||'')!=='trial'&&
      ['jellyfin','bundle'].includes(String(hold.service_type||'jellyfin'))&&
      planPolicy.hasUsageTrigger(effective)
    );
    if(applies)continue;
    await accessHolds.releaseHold({customerId,type:HOLD_TYPE,sourceKey:hold.source_key,actorUserId});
    released++;
  }
  return released;
}
module.exports={HOLD_TYPE,releaseObsoleteForCustomer};
