'use strict';

const {query}=require('../db');
const outbound=require('../security/outbound-url-policy');
const foundation=require('./foundation');
const mediaIndex=require('./media-index');
const entitlements=require('./entitlements');

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
async function admission(entitlement){const active=await activeStreamCount(entitlement),limit=Math.max(1,Number(entitlement.stream_limit||1));return{allowed:active<limit,active,limit};}

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

function sourceFilename(item,source){const path=String(source?.Path||item?.Path||'');return path?path.split(/[\\/]/).pop():`${item?.Name||'video'}.mkv`;}
function sourceQuality(source,filename){
  const parsed=foundation.streamDisplayFromFilename(filename),height=Number(source?.Height||source?.MediaStreams?.find(s=>s.Type==='Video')?.Height||0),bitrate=Number(source?.Bitrate||0);
  let rank=0;if(parsed.quality==='4K'||height>=2000)rank=400;if(parsed.quality==='1080p'||height>=1000&&height<2000)rank=Math.max(rank,300);if(parsed.quality==='720p'||height>=700&&height<1000)rank=Math.max(rank,200);if(parsed.remux)rank+=35;if(parsed.source==='BluRay')rank+=20;if(parsed.source==='WEB-DL')rank+=10;rank+=Math.min(20,bitrate/5000000);
  return{parsed,height,bitrate,rank};
}
function enrichDescription(parsed,source){
  const parts=[];const video=Array.isArray(source?.MediaStreams)?source.MediaStreams.find(s=>s.Type==='Video'):null,audio=Array.isArray(source?.MediaStreams)?source.MediaStreams.find(s=>s.Type==='Audio'):null;
  if(parsed.detail)parts.push(parsed.detail);if(video?.DisplayTitle&&!parts.some(p=>p.includes(video.DisplayTitle)))parts.push(video.DisplayTitle);if(audio?.DisplayTitle)parts.push(audio.DisplayTitle);
  if(Number(source?.Bitrate)>0)parts.push(`${(Number(source.Bitrate)/1000000).toFixed(1)} Mbps`);return parts.filter(Boolean).join(' · ');
}

async function streamsFor(entitlement,type,videoId){
  const args=parseVideoId(type,videoId);if(!args)return[];
  const gate=await admission(entitlement);if(!gate.allowed)return[];
  const item=await resolveItem(entitlement,args);if(!item)return[];
  const qs=new URLSearchParams({UserId:String(entitlement.jellyfin_user_id)});
  const playback=await restrictedRequest(entitlement,`/Items/${encodeURIComponent(item.id)}/PlaybackInfo?${qs.toString()}`);
  const sources=(Array.isArray(playback?.MediaSources)?playback.MediaSources:[]).filter(source=>source&&source.Id&&source.SupportsDirectPlay!==false);
  const token=entitlements.accessToken(entitlement),publicBase=String(entitlement.public_url||'').replace(/\/$/,'');if(!publicBase)return[];
  return sources.map(source=>{
    const filename=sourceFilename(item,source),q=sourceQuality(source,filename),display=q.parsed;
    const streamUrl=new URL(`/Videos/${encodeURIComponent(item.id)}/stream`,`${publicBase}/`);streamUrl.searchParams.set('Static','true');streamUrl.searchParams.set('MediaSourceId',String(source.Id));
    const quality=display.quality||(q.height?`${q.height}p`:'Direct');
    return{rank:q.rank,stream:{name:`[CF ⚡] ${quality}`,description:enrichDescription(display,source)||'Direct Jellyfin stream',url:streamUrl.toString(),behaviorHints:{notWebReady:true,bingeGroup:`captainfin-${quality.toLowerCase().replace(/[^a-z0-9]+/g,'-')}`,proxyHeaders:{request:{Authorization:entitlements.jellyfinAuthHeader(token)}},filename,videoSize:Number(source.Size)>0?Number(source.Size):undefined}}};
  }).sort((a,b)=>b.rank-a.rank).map(row=>{const stream=row.stream;if(stream.behaviorHints.videoSize===undefined)delete stream.behaviorHints.videoSize;return stream;});
}

module.exports={restrictedRequest,activeStreamCount,admission,parseVideoId,resolveItem,streamsFor,sourceQuality};
