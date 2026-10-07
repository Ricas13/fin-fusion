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

  let recovered=await installRecovery.current(customerId,{subscriptionId:entitlement.subscription_id});
  let credential=recovered?.credential||null;

  // Revenue-critical invariant: merely reading My Access must repair a missing
  // current-term installation credential. Do not rely on frontend JavaScript,
  // a separate Retry POST, source readiness, or another provisioning lane.
  if(!credential){
    const ensured=await entitlements.ensureInstallationCredential(customerId,{entitlement});
    credential=ensured?.credential||null;
    if(!credential&&ensured?.reused){
      recovered=await installRecovery.current(customerId,{subscriptionId:entitlement.subscription_id});
      credential=recovered?.credential||null;
    }
  }

  if(!credential)return{manifestUrl:null,installUrl:null};
  const manifestUrl=await operations.absoluteUrl(req,`/stremio/${encodeURIComponent(credential)}/manifest.json`);
  return{manifestUrl,installUrl:deepLink(manifestUrl)};
}

module.exports={current,deepLink};
