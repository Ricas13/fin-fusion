'use strict';

const crypto=require('crypto');

const TTL_SECONDS=900;
function secret(){const raw=String(process.env.SESSION_SECRET||'');if(raw.length<32)throw new Error('SESSION_SECRET is unavailable for Stremio playback capability signing.');return crypto.createHash('sha256').update('captainfin:stremio-source-capability:v1\0').update(raw,'utf8').digest();}
function clean(value,max=300){const text=String(value||'').trim();if(!text||text.length>max||/[\r\n\0]/.test(text))throw new Error('Invalid Stremio playback capability scope.');return text;}
function payload(entitlementId,sourceId,itemId,mediaSourceId,expiresAt){return [clean(entitlementId,80),clean(sourceId,80),clean(itemId,200),clean(mediaSourceId,300),String(expiresAt)].join('\n');}
function signature(body){return crypto.createHmac('sha256',secret()).update(body,'utf8').digest('base64url');}
function issue(entitlementId,sourceId,itemId,mediaSourceId,{now=Date.now()}={}){const expiresAt=Math.floor(now/1000)+TTL_SECONDS,body=payload(entitlementId,sourceId,itemId,mediaSourceId,expiresAt);return `${expiresAt}.${signature(body)}`;}
function verify(token,entitlementId,sourceId,itemId,mediaSourceId,{now=Date.now()}={}){
  const match=String(token||'').match(/^(\d{10,13})\.([A-Za-z0-9_-]{43})$/);if(!match)return false;
  const expiresAt=Number(match[1]);if(!Number.isSafeInteger(expiresAt)||expiresAt<Math.floor(now/1000)||expiresAt>Math.floor(now/1000)+TTL_SECONDS+60)return false;
  let expected;try{expected=signature(payload(entitlementId,sourceId,itemId,mediaSourceId,expiresAt));}catch{return false;}
  const supplied=Buffer.from(match[2]),wanted=Buffer.from(expected);return supplied.length===wanted.length&&crypto.timingSafeEqual(supplied,wanted);
}
module.exports={TTL_SECONDS,issue,verify};
