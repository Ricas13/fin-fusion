'use strict';

const installRecovery=require('./install-credential-recovery');
const entitlements=require('./entitlements');
const operations=require('../platform/operations-settings');

function deepLink(manifestUrl){
  if(!manifestUrl)return null;
  const url=new URL(manifestUrl);
  return `stremio://${url.host}${url.pathname}${url.search}`;
}

async function current(req,customerId){
  const entitlement=await entitlements.entitledSubscription(customerId);
  if(!entitlement?.subscription_id)return{manifestUrl:null,installUrl:null};
  const recovered=await installRecovery.current(customerId,{subscriptionId:entitlement.subscription_id});
  if(!recovered?.credential)return{manifestUrl:null,installUrl:null};
  const manifestUrl=await operations.absoluteUrl(req,`/stremio/${encodeURIComponent(recovered.credential)}/manifest.json`);
  return{manifestUrl,installUrl:deepLink(manifestUrl)};
}

module.exports={current,deepLink};
