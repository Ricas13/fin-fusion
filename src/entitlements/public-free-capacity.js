'use strict';

// Public Free availability is an estimate, not the transactional acquisition
// authority. Match the actual per-server placement model conservatively without
// changing reservation-aware lockAndAssert or claimFreePlan.
const {query}=require('../db');
const planCapacity=require('./plan-capacity');
const serverChoice=require('../jellyfin/customer-server-choice');
const userCapacity=require('../jellyfin/user-capacity');

function placeableFreeSeats(servers){
  return (Array.isArray(servers)?servers:[]).reduce((sum,server)=>{
    // Model A excludes NULL and treats zero as zero. Model B currently treats
    // NULL/zero as unlimited; never advertise those as extra public places.
    const limit=server?.max_users==null?0:Number(server.max_users);
    if(!Number.isInteger(limit)||limit<=0)return sum;
    const used=Number(server.capacity_users??server.assigned_users??0);
    if(!Number.isFinite(used)||used<0)throw new Error('Invalid media server capacity owner count');
    return sum+Math.max(0,limit-used);
  },0);
}

async function usage(planId,db=query,{
  modelUsage=planCapacity.usage,
  eligibleServers=serverChoice.eligibleServers,
  decorateServers=userCapacity.decorateServers
}={}){
  const state=await modelUsage(planId,db);
  if(state?.model!=='fleet_users'||state?.plan?.is_free_tier!==true ||
     !['jellyfin','bundle'].includes(String(state.plan.service_type||'')))return state;

  const eligible=await eligibleServers(state.plan,{db});
  const decorated=await decorateServers(eligible,db);
  const placeableRemaining=placeableFreeSeats(decorated);
  const modelARemaining=Math.max(0,Number(state.remaining)||0);
  const remaining=Math.min(modelARemaining,placeableRemaining);
  const updated={...state,remaining,soldOut:remaining===0,
    modelARemaining,placeableRemaining};
  return{...updated,...planCapacity.scarcity(updated)};
}

module.exports={usage,placeableFreeSeats};
