'use strict';

const crypto=require('crypto');
const {query}=require('../db');
const outbound=require('../security/outbound-url-policy');
const operations=require('../platform/operations-settings');
const {decryptWithEnv}=require('../security/purpose-crypto');

const TOKEN_ENV='STREMIO_JELLYFIN_TOKEN_KEY';
const TOKEN_PREFIX='stremio-source-token';
const GRANT_HOURS=12;
function hash(raw){return crypto.createHash('sha256').update(String(raw||''),'utf8').digest('hex');}
function authHeader(token,deviceId='captainfin-stremio-gateway'){if(/[\r\n]/.test(String(token||'')))throw new Error('Invalid Jellyfin source token');return `MediaBrowser Client="CAPTaINFiN Stremio", Device="CAPTaINFiN Bridge", DeviceId="${deviceId}", Version="1.0", Token="${token}"`;}
function safeFilename(value){return String(value||'video.mkv').replace(/[\r\n/\\]/g,'_').slice(0,240)||'video.mkv';}
function validRange(value){const raw=String(value||'').trim();return /^bytes=\d*-\d*$/.test(raw)?raw:null;}

async function issue({entitlement,source,account,itemId,mediaSourceId,filename}){
  const cfg=await operations.get();if(!cfg.publicBaseUrl)throw new Error('Public base URL is required before pooled Stremio streams can be issued.');
  const raw=crypto.randomBytes(32).toString('base64url'),tokenHash=hash(raw),expiresAt=new Date(Date.now()+GRANT_HOURS*3600000),clean=safeFilename(filename);
  await query(`INSERT INTO stremio_stream_grants(token_hash,entitlement_id,customer_id,source_id,source_account_id,item_id,media_source_id,filename,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[tokenHash,entitlement.id,entitlement.customer_id,source.id,account.id,String(itemId),String(mediaSourceId),clean,expiresAt]);
  const url=new URL(`/stremio/media/${encodeURIComponent(raw)}/${encodeURIComponent(clean)}`,`${cfg.publicBaseUrl.replace(/\/$/,'')}/`);
  return{url:url.toString(),expiresAt};
}

async function resolve(raw){
  const tokenHash=hash(raw);
  const r=await query(`WITH effective AS (
      SELECT customer_id,subscription_id,access_expires_at,blocked FROM effective_customer_entitlements
      UNION ALL
      SELECT customer_id,subscription_id,access_expires_at,blocked FROM effective_customer_addons
    )
    SELECT g.*,s.name source_name,s.base_url,s.enabled source_enabled,a.label source_account_label,a.jellyfin_user_id,a.access_token_encrypted,a.enabled account_enabled,e.subscription_id,e.status entitlement_status,
      ee.access_expires_at,ee.blocked
    FROM stremio_stream_grants g
    JOIN stremio_sources s ON s.id=g.source_id
    JOIN stremio_source_accounts a ON a.id=g.source_account_id
    JOIN stremio_entitlements e ON e.id=g.entitlement_id AND e.customer_id=g.customer_id
    JOIN effective ee ON ee.customer_id=g.customer_id AND ee.subscription_id=e.subscription_id
    WHERE g.token_hash=$1 AND g.expires_at>NOW() AND s.enabled=TRUE AND a.enabled=TRUE
      AND e.status='active' AND ee.blocked=FALSE AND ee.access_expires_at>NOW()
    LIMIT 1`,[tokenHash]);
  return r.rows[0]||null;
}

async function proxy(req,res){
  const grant=await resolve(req.params.grant);if(!grant)return res.status(404).end();
  const token=decryptWithEnv(grant.access_token_encrypted,TOKEN_ENV,TOKEN_PREFIX),base=new URL(grant.base_url),url=new URL(`/Videos/${encodeURIComponent(grant.item_id)}/stream`,`${grant.base_url.replace(/\/$/,'')}/`);
  if(url.origin!==base.origin)throw new Error('Stremio gateway escaped configured source origin.');
  url.searchParams.set('Static','true');url.searchParams.set('MediaSourceId',String(grant.media_source_id));url.searchParams.set('UserId',String(grant.jellyfin_user_id));
  const range=validRange(req.headers.range),headers={Authorization:authHeader(token,`cfgw-${String(grant.customer_id).replace(/-/g,'').slice(0,20)}`),Accept:'*/*'};if(range)headers.Range=range;
  const abort=new AbortController();req.on('close',()=>abort.abort());
  const upstream=await outbound.safeStream(url,{purpose:`Stremio stream gateway ${grant.source_name}`,method:req.method==='HEAD'?'HEAD':'GET',headers,timeoutMs:15000,signal:abort.signal});
  res.status(upstream.status);
  for(const name of ['content-type','content-length','content-range','accept-ranges','etag','last-modified','cache-control']){const value=upstream.headers?.[name];if(value!==undefined)res.setHeader(name,value);}
  res.setHeader('Cache-Control','private, no-store');
  await query('UPDATE stremio_stream_grants SET last_used_at=NOW() WHERE id=$1',[grant.id]).catch(()=>{});
  if(req.method==='HEAD'){upstream.stream.destroy();return res.end();}
  upstream.stream.on('error',error=>{console.warn('Stremio gateway upstream stream failed:',error.message);if(!res.headersSent)res.status(502).end();else res.destroy(error);});
  res.on('close',()=>upstream.stream.destroy());
  upstream.stream.pipe(res);
}

async function cleanupExpired(limit=500){const r=await query(`DELETE FROM stremio_stream_grants WHERE id IN(SELECT id FROM stremio_stream_grants WHERE expires_at<NOW()-INTERVAL '1 hour' ORDER BY expires_at LIMIT $1)`,[Math.max(1,Math.min(5000,Number(limit)||500))]);return r.rowCount;}

module.exports={TOKEN_ENV,TOKEN_PREFIX,GRANT_HOURS,hash,issue,resolve,proxy,cleanupExpired,validRange,safeFilename};
