'use strict';

const {query}=require('../db');

async function usage(tierId,db=query){
  const r=await db(`SELECT rt.id,rt.capacity_limit,
    (SELECT COUNT(DISTINCT rs.reseller_id)::int FROM reseller_subscriptions rs WHERE rs.tier_id=rt.id AND rs.status IN('active','past_due') AND rs.current_period_end>NOW()) used
    FROM reseller_tiers rt WHERE rt.id=$1`,[tierId]);
  if(!r.rowCount)throw new Error('Reseller plan not found.');
  const row=r.rows[0],limit=row.capacity_limit==null?null:Number(row.capacity_limit),used=Number(row.used||0),configured=limit!=null,remaining=configured?Math.max(0,limit-used):null;
  return{tierId:row.id,limit,used,remaining,configured,soldOut:!configured||remaining<=0};
}
async function assertAvailable(tierId,{label='This reseller plan'}={}){const state=await usage(tierId);if(!state.configured)throw new Error(`${label} does not have storefront inventory configured yet.`);if(state.soldOut)throw new Error(`${label} is currently sold out.`);return state;}
module.exports={usage,assertAvailable};
