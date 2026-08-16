'use strict';

const {query}=require('../db');
const accessHolds=require('./access-holds');
const HOLD_TYPE='inactivity_policy';

async function releaseObsoleteForCustomer(customerId,actorUserId=null){
  const holds=await query(`SELECT source_key FROM customer_access_holds WHERE customer_id=$1 AND hold_type=$2 AND released_at IS NULL`,[customerId,HOLD_TYPE]);
  if(!holds.rowCount)return 0;
  const effective=await query(`SELECT e.plan_id,p.price_minor,p.billing_interval,p.service_type,p.inactivity_policy FROM effective_customer_entitlements e JOIN plans p ON p.id=e.plan_id WHERE e.customer_id=$1 LIMIT 1`,[customerId]);
  const plan=effective.rows[0]||null;let released=0;
  for(const hold of holds.rows){
    const applies=Boolean(plan)&&hold.source_key===`plan:${plan.plan_id}`&&Number(plan.price_minor||0)===0&&String(plan.billing_interval||'')!=='trial'&&['jellyfin','bundle'].includes(String(plan.service_type||'jellyfin'))&&plan.inactivity_policy?.enabled===true;
    if(applies)continue;
    await accessHolds.releaseHold({customerId,type:HOLD_TYPE,sourceKey:hold.source_key,actorUserId});released++;
  }
  return released;
}
module.exports={HOLD_TYPE,releaseObsoleteForCustomer};
