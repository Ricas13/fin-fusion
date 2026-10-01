'use strict';

const customerAccessState=require('./customer-access-state');
const provisioning=require('../jellyfin/resilient-provisioning');
const manualAssignment=require('../jellyfin/manual-assignment');
const forceMove=require('../jellyfin/admin-force-move');
const adminControl=require('../jellyfin/admin-control');

function clean(value,max=500){return String(value||'').trim().slice(0,max);}

async function canonicalJellyfinAccess(customerId){
  const access=await customerAccessState.snapshot(customerId);
  if(access.primary?.entitlement)return{lane:'primary',...access.primary};
  if(access.free?.entitlement)return{lane:'free',...access.free};
  return{lane:null,state:customerAccessState.ACCESS_STATES.NONE,entitlement:null,account:null};
}

async function assign(customerId,serverId,{actorUserId=null}={}){
  return manualAssignment.assign(customerId,serverId,{actorUserId});
}

async function move(customerId,serverId,{actorUserId=null}={}){
  return forceMove.move(customerId,serverId,{actorUserId});
}

async function remove(customerId,{actorUserId=null,reason=''}={}){
  const access=await canonicalJellyfinAccess(customerId);
  const entitlement=access.entitlement;
  if(!entitlement)throw new Error('This customer has no Jellyfin entitlement to control.');
  await adminControl.remove(customerId,entitlement.subscription_id,{
    actorUserId,
    reason:clean(reason,500)||'Removed from Jellyfin by administrator'
  });
  await provisioning.reconcileCustomer(customerId);
  return{lane:access.lane,subscriptionId:entitlement.subscription_id};
}

async function automatic(customerId,{actorUserId=null}={}){
  const access=await canonicalJellyfinAccess(customerId);
  const entitlement=access.entitlement;
  if(!entitlement)throw new Error('This customer has no current Jellyfin entitlement.');
  await adminControl.clear(customerId,entitlement.subscription_id,{actorUserId});
  let reconcileError=null;
  try{await provisioning.reconcileCustomer(customerId);}
  catch(error){reconcileError=error;}
  return{lane:access.lane,subscriptionId:entitlement.subscription_id,reconcileError};
}

async function fix(customerId){
  return provisioning.reconcileCustomer(customerId);
}

module.exports={
  clean,
  canonicalJellyfinAccess,
  assign,
  move,
  remove,
  automatic,
  fix
};
