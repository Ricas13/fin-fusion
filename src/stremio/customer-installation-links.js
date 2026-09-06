'use strict';

const installRecovery=require('./install-credential-recovery');
const operations=require('../platform/operations-settings');

function deepLink(manifestUrl){
  if(!manifestUrl)return null;
  const url=new URL(manifestUrl);
  return `stremio://${url.host}${url.pathname}${url.search}`;
}

async function current(req,customerId){
  const recovered=await installRecovery.current(customerId);
  if(!recovered?.credential)return{manifestUrl:null,installUrl:null};
  const manifestUrl=await operations.absoluteUrl(req,`/stremio/${encodeURIComponent(recovered.credential)}/manifest.json`);
  return{manifestUrl,installUrl:deepLink(manifestUrl)};
}

module.exports={current,deepLink};
