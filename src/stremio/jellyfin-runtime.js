'use strict';

const http=require('http');
const https=require('https');
const net=require('net');
const {query}=require('../db');
const outbound=require('../security/outbound-url-policy');
const registry=require('../jellyfin/registry');
const foundation=require('./foundation');
const mediaIndex=require('./media-index');
const entitlements=require('./entitlements');
const sourcePlayback=require('./source-playback');

let streamManagerTimer=null;
let streamManagerRunning=false;

function restrictedHeaders(token,{json=false}={}){return{Authorization:entitlements.jellyfinAuthHeader(token),Accept:'application/json',...(json?{'Content-Type':'application/json'}:{})};}
async function restrictedRequest(entitlement,endpoint,{method='GET',body=null,timeoutMs=12000}={}){
  if(typeof endpoint!=='string'||!endpoint.startsWith('/')||endpoint.startsWith('//'))throw new Error('Invalid restricted Jellyfin endpoint.');
  const base=new URL(String(entitlement.base_url));const url=new URL(endpoint,`${base.toString().replace(/\/$/,'')}/`);
  if(url.origin!==base.origin)throw new Error('Restricted Jellyfin endpoint escaped the configured server origin.');
  const token=entitlements.accessToken(entitlement);
  const response=await outbound.safeFetch(url,{purpose:`Stremio restricted Jellyfin request on ${entitlement.server_name}`,method,timeoutMs,headers:restrictedHeaders(token,{json:body!==null}),...(body!==null?{body:JSON.stringify(body)}:{})});
  const text=await response.text();let parsed={};if(text){try{parsed=JSON.parse(text);}catch{parsed=text;}}
  if(!response.ok){const error=new Error(`Restricted Jellyfin request returned HTTP ${response.status}`);error.status=response.status;throw error;}
  return parsed;
}

async function activeStreamCount(entitlement){
  const r=await query(`SELECT COUNT(DISTINCT jellyfin_session_id)::int n FROM active_playback_sessions
    WHERE jellyfin_account_id=$1 AND last_seen_at>NOW()-INTERVAL '150 seconds'`,[entitlement.jellyfin_account_id]);
  return Number(r.rows[0]?.n||0);
}

async function jellyfinSessions(entitlement,{activeWithinSeconds=180}={}){
  if(!entitlement?.server_id||!entitlement?.jellyfin_user_id)return[];
  const sessions=await registry.request(entitlement.server_id,`/Sessions?activeWithinSeconds=${encodeURIComponent(Math.max(30,Math.min(600,Number(activeWithinSeconds)||180)))}`);
  if(!Array.isArray(sessions))return[];
  const userId=String(entitlement.jellyfin_user_id).toLowerCase();
  return sessions.filter(session=>session?.Id&&session?.NowPlayingItem&&String(session.UserId||'').toLowerCase()===userId);
}
async function admission(entitlement){const sessions=await jellyfinSessions(entitlement),active=sessions.length,limit=Math.max(1,Number(entitlement.stream_limit||1));return{allowed:active<limit,active,limit,sessions};}

function parseVideoId(type,videoId){
  if(type==='movie'){const imdb=mediaIndex.normalizeImdb(videoId);return imdb?{type:'movie',imdb}:null;}
  if(type!=='series')return null;
  const match=String(videoId||'').match(/^(tt\d{5,12}):(\d{1,3}):(\d{1,4})$/i);if(!match)return null;
  return{type:'series',imdb:match[1].toLowerCase(),season:Number(match[2]),episode:Number(match[3])};
}

async function resolveItem(entitlement,args){
  const indexed=await mediaIndex.lookup(entitlement.server_id,args.imdb,args.type);if(!indexed)return null;
  if(args.type==='movie')return{id:indexed.item_id,name:indexed.name,path:indexed.path,type:'Movie'};
  const qs=new URLSearchParams({UserId:String(entitlement.jellyfin_user_id),Season:String(args.season),Fields:'Path,MediaSources,MediaStreams',StartIndex:'0',Limit:'500',EnableImages:'false'});
  const payload=await restrictedRequest(entitlement,`/Shows/${encodeURIComponent(indexed.item_id)}/Episodes?${qs.toString()}`);
  const items=Array.isArray(payload?.Items)?payload.Items:[];
  const item=items.find(row=>Number(row.IndexNumber)===args.episode&&Number(row.ParentIndexNumber??args.season)===args.season);
  return item?{...item,id:String(item.Id),name:item.Name||indexed.name,path:item.Path||null,type:'Episode'}:null;
}

function basenameFromPath(value){
  const raw=String(value||'').trim();if(!raw)return'';
  try{const parsed=new URL(raw);return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop()||'');}catch(_){return raw.split(/[\\/]/).pop()||'';}
}
function sourceFilename(item,source){
  const itemPath=String(item?.path||item?.Path||''),sourcePath=String(source?.Path||'');
  const preferred=/\.strm(?:$|[?#])/i.test(itemPath)?itemPath:(sourcePath||itemPath);
  return basenameFromPath(preferred)||`${item?.name||item?.Name||'video'}.mkv`;
}
function sourceQuality(source,filename){
  const display=foundation.streamDisplayFromFilename(filename),meta=display.metadata||{},height=Number(source?.Height||source?.MediaStreams?.find(s=>s.Type==='Video')?.Height||0),bitrate=Number(source?.Bitrate||0);
  let rank=0;if(meta.resolution==='4K'||height>=2000)rank=400;if(meta.resolution==='1080p'||height>=1000&&height<2000)rank=Math.max(rank,300);if(meta.resolution==='720p'||height>=700&&height<1000)rank=Math.max(rank,200);if(meta.source==='REMUX')rank+=35;if(meta.source==='BluRay')rank+=20;if(meta.source==='WEB-DL')rank+=10;rank+=Math.min(20,bitrate/5000000);
  return{display,meta,height,bitrate,rank};
}
function streamDescription(quality,source){
  const meta=quality.meta||{},streams=Array.isArray(source?.MediaStreams)?source.MediaStreams:[],video=streams.find(s=>s.Type==='Video'),audio=streams.find(s=>s.Type==='Audio'),parts=[];
  const videoFallback=[meta.codec,...(Array.isArray(meta.dynamicRange)?meta.dynamicRange:[])].filter(Boolean).join(' · ');
  if(video?.DisplayTitle)parts.push(`📺 ${video.DisplayTitle}`);else if(videoFallback)parts.push(`📺 ${videoFallback}`);
  if(audio?.DisplayTitle)parts.push(`🔊 ${audio.DisplayTitle}`);else if(meta.audio)parts.push(`🔊 ${[meta.audio,meta.channels].filter(Boolean).join(' · ')}`);
  if(Number(source?.Bitrate)>0)parts.push(`📶 ${(Number(source.Bitrate)/1000000).toFixed(1)} Mbps`);
  if(meta.releaseGroup)parts.push(`🏷️ ${meta.releaseGroup}`);
  return parts.join('\n')||'▶️ Direct Jellyfin playback';
}

async function streamsFor(entitlement,type,videoId,{proxyBase,installToken}={}){
  const args=parseVideoId(type,videoId);if(!args)return[];
  const item=await resolveItem(entitlement,args);if(!item)return[];
  const qs=new URLSearchParams({UserId:String(entitlement.jellyfin_user_id)});
  const playback=await restrictedRequest(entitlement,`/Items/${encodeURIComponent(item.id)}/PlaybackInfo?${qs.toString()}`);
  const sources=(Array.isArray(playback?.MediaSources)?playback.MediaSources:[]).filter(source=>source&&source.Id&&source.SupportsDirectPlay!==false);
  const portalBase=String(proxyBase||'').replace(/\/$/,'');const install=String(installToken||'').trim();if(!portalBase||!install)return[];
  return sources.map(source=>{
    const filename=sourceFilename(item,source),q=sourceQuality(source,filename),quality=q.meta.resolution||(q.height?`${q.height}p`:'Direct'),sourceLabel=q.meta.source?` · ${q.meta.source}`:'';
    const streamUrl=new URL(`/stremio/${encodeURIComponent(install)}/jellyfin/${encodeURIComponent(item.id)}/${encodeURIComponent(String(source.Id))}`,`${portalBase}/`);
    return{rank:q.rank,stream:{name:`[CAPTAiNFiN] ${quality}${sourceLabel}`,description:streamDescription(q,source),url:streamUrl.toString(),behaviorHints:{notWebReady:true,bingeGroup:`captainfin-${quality.toLowerCase().replace(/[^a-z0-9]+/g,'-')}`,filename,videoSize:Number(source.Size)>0?Number(source.Size):undefined}}};
  }).sort((a,b)=>b.rank-a.rank).map(row=>{const stream=row.stream;if(stream.behaviorHints.videoSize===undefined)delete stream.behaviorHints.videoSize;return stream;});
}

async function openPlayback(entitlement,itemId,mediaSourceId,rangeHeader='',method='GET'){
  const item=String(itemId||'').trim(),media=String(mediaSourceId||'').trim(),verb=String(method||'GET').toUpperCase();
  if(!item||item.length>200||!media||media.length>300)throw new Error('Invalid Jellyfin playback identifier.');
  if(!['GET','HEAD'].includes(verb))throw new Error('Unsupported Jellyfin playback method.');
  const base=new URL(String(entitlement.base_url));const url=new URL(`/Videos/${encodeURIComponent(item)}/stream`,`${base.toString().replace(/\/$/,'')}/`);
  if(url.origin!==base.origin)throw new Error('Managed Jellyfin playback escaped the configured server origin.');
  url.searchParams.set('Static','true');url.searchParams.set('MediaSourceId',media);
  const checked=await outbound.assertSafeIntegrationUrl(url,{purpose:`CAPTAiNFiN managed Stremio playback on ${entitlement.server_name}`});
  const address=checked.addresses.find(v=>net.isIP(v)===4)||checked.addresses[0],family=net.isIP(address),transport=url.protocol==='https:'?https:http;
  const headers={Authorization:entitlements.jellyfinAuthHeader(entitlements.accessToken(entitlement)),Accept:'*/*'},safeRange=sourcePlayback.range(rangeHeader);if(safeRange)headers.Range=safeRange;
  return new Promise((resolve,reject)=>{
    const lookup=(_hostname,options,callback)=>{if(typeof options==='function'){callback=options;options={};}if(options?.all)return callback(null,[{address,family}]);return callback(null,address,family);};
    const request=transport.request(url,{method:verb,headers,lookup},response=>resolve({request,response,url,method:verb}));
    request.setTimeout(15000,()=>request.destroy(new Error('Managed Jellyfin playback connection timed out.')));request.on('error',reject);request.end();
  });
}

async function reconcileEntitlement(entitlement){
  const limit=Math.max(1,Number(entitlement.stream_limit||1));let sessions=await jellyfinSessions(entitlement);if(sessions.length<=limit)return{active:sessions.length,limit,stopped:0};
  const observed=await query(`SELECT jellyfin_session_id,first_seen_at FROM active_playback_sessions WHERE jellyfin_account_id=$1`,[entitlement.jellyfin_account_id]);
  const firstSeen=new Map(observed.rows.map(row=>[String(row.jellyfin_session_id),new Date(row.first_seen_at).getTime()]));
  sessions=sessions.slice().sort((a,b)=>{
    const aTime=firstSeen.get(String(a.Id))??(Date.parse(a.LastActivityDate||'')||0);
    const bTime=firstSeen.get(String(b.Id))??(Date.parse(b.LastActivityDate||'')||0);
    return aTime-bTime;
  });
  let stopped=0;
  for(const candidate of sessions.slice(limit)){
    const fresh=await jellyfinSessions(entitlement);if(fresh.length<=limit)break;
    if(!fresh.some(row=>String(row.Id)===String(candidate.Id)))continue;
    try{await registry.request(entitlement.server_id,`/Sessions/${encodeURIComponent(String(candidate.Id))}/Playing/Stop`,{method:'POST'});stopped+=1;}catch(error){console.warn(`Unable to stop excess Stremio session ${candidate.Id}: ${error.message}`);}
  }
  return{active:sessions.length,limit,stopped};
}
async function reconcileManagedStreams(){
  const rows=await query(`SELECT e.id,e.customer_id,e.server_id,e.jellyfin_account_id,e.stream_limit,ja.jellyfin_user_id,js.base_url,js.public_url,js.name server_name
    FROM stremio_entitlements e JOIN jellyfin_accounts ja ON ja.id=e.jellyfin_account_id JOIN jellyfin_servers js ON js.id=e.server_id
    WHERE e.status='active' AND ja.account_purpose='stremio_internal' AND ja.disabled=FALSE AND js.enabled=TRUE AND js.stremio_enabled=TRUE`);
  let checked=0,stopped=0;for(const row of rows.rows){try{const result=await reconcileEntitlement(row);checked+=1;stopped+=result.stopped;}catch(error){console.warn(`Stremio stream reconciliation failed for entitlement ${row.id}: ${error.message}`);}}
  return{checked,stopped};
}
function startStreamManager({intervalMs=60000}={}){
  if(streamManagerTimer)return streamManagerTimer;const delay=Math.max(15000,Math.min(300000,Number(intervalMs)||60000));
  streamManagerTimer=setInterval(async()=>{if(streamManagerRunning)return;streamManagerRunning=true;try{await reconcileManagedStreams();}catch(error){console.warn(`Stremio stream manager cycle failed: ${error.message}`);}finally{streamManagerRunning=false;}},delay);streamManagerTimer.unref?.();return streamManagerTimer;
}

module.exports={restrictedRequest,activeStreamCount,jellyfinSessions,admission,parseVideoId,resolveItem,streamsFor,sourceQuality,sourceFilename,basenameFromPath,streamDescription,openPlayback,reconcileEntitlement,reconcileManagedStreams,startStreamManager};
