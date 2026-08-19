'use strict';

const {query}=require('../db');
const client=require('./source-client');
const sourceIndex=require('./source-index');
const sourcePool=require('./source-pool');
const foundation=require('./foundation');
const {neutralGroup}=require('./managed-runtime');

function parseVideoId(type,videoId){
  if(type==='movie'){const imdb=sourceIndex.normalizeImdb(videoId);return imdb?{type:'movie',imdb}:null;}
  if(type!=='series')return null;
  const match=String(videoId||'').match(/^(tt\d{5,12}):(\d{1,3}):(\d{1,4})$/i);if(!match)return null;
  return{type:'series',imdb:match[1].toLowerCase(),season:Number(match[2]),episode:Number(match[3])};
}
function basename(value){const raw=String(value||'').trim();if(!raw)return'';try{const parsed=new URL(raw);return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop()||'');}catch{return raw.split(/[\\/]/).pop()||'';}}
function filename(item,media){const itemPath=String(item?.Path||item?.path||''),mediaPath=String(media?.Path||'');const preferred=/\.strm(?:$|[?#])/i.test(itemPath)?itemPath:(mediaPath||itemPath);return basename(preferred)||`${item?.Name||item?.name||'video'}.mkv`;}
function quality(media,display){const meta=display.metadata||{},height=Number(media?.Height||media?.MediaStreams?.find(s=>s.Type==='Video')?.Height||0),bitrate=Number(media?.Bitrate||0);let rank=0;if(meta.resolution==='4K'||height>=2000)rank=400;if(meta.resolution==='1080p'||height>=1000&&height<2000)rank=Math.max(rank,300);if(meta.resolution==='720p'||height>=700&&height<1000)rank=Math.max(rank,200);if(meta.source==='REMUX')rank+=35;if(meta.source==='BluRay')rank+=20;if(meta.source==='WEB-DL')rank+=10;rank+=Math.min(20,bitrate/5000000);return{height,rank};}
function description(display,media){const parts=String(display.description||'').split('\n').map(v=>v.trim()).filter(Boolean),streams=Array.isArray(media?.MediaStreams)?media.MediaStreams:[],video=streams.find(s=>s.Type==='Video'),audio=streams.find(s=>s.Type==='Audio');if(video?.DisplayTitle&&!parts.some(p=>p.includes(video.DisplayTitle)))parts.push(`📺 ${video.DisplayTitle}`);if(audio?.DisplayTitle&&!parts.some(p=>p.includes(audio.DisplayTitle)))parts.push(`🔊 ${audio.DisplayTitle}`);if(Number(media?.Bitrate)>0)parts.push(`📶 ${(Number(media.Bitrate)/1000000).toFixed(1)} Mbps`);return parts.join('\n')||'▶️ Stream';}
function directUrl(source,itemId,mediaSourceId,playSessionId=''){
  const base=String(source.public_url||source.base_url||'').replace(/\/$/,'');if(!base)throw new Error('External Jellyfin public URL is missing.');
  const url=new URL(`/Videos/${encodeURIComponent(String(itemId))}/stream`,`${base}/`);
  url.searchParams.set('Static','true');url.searchParams.set('MediaSourceId',String(mediaSourceId));url.searchParams.set('api_key',client.sourceToken(source));if(playSessionId)url.searchParams.set('PlaySessionId',String(playSessionId));return url.toString();
}
async function roots(source,args){return sourceIndex.lookupAll(source.id,args.imdb,args.type);}
async function items(source,args){
  const indexed=await roots(source,args);if(!indexed.length)return[];
  if(args.type==='movie')return indexed.map(row=>({Id:row.item_id,Name:row.name,Path:row.path}));
  const settled=await Promise.allSettled(indexed.map(async row=>{
    const qs=new URLSearchParams({UserId:String(source.jellyfin_user_id),Season:String(args.season),Fields:'Path,MediaSources,MediaStreams',StartIndex:'0',Limit:'500',EnableImages:'false'});
    const payload=await client.request(source,`/Shows/${encodeURIComponent(row.item_id)}/Episodes?${qs.toString()}`);
    return (Array.isArray(payload?.Items)?payload.Items:[]).find(item=>Number(item.IndexNumber)===args.episode&&Number(item.ParentIndexNumber??args.season)===args.season)||null;
  }));
  return settled.filter(row=>row.status==='fulfilled'&&row.value).map(row=>row.value);
}
async function streamsFrom(source,args,type,videoId){
  const found=await items(source,args),out=[];
  for(const item of found){
    const qs=new URLSearchParams({UserId:String(source.jellyfin_user_id)}),playback=await client.request(source,`/Items/${encodeURIComponent(item.Id)}/PlaybackInfo?${qs.toString()}`),mediaSources=(Array.isArray(playback?.MediaSources)?playback.MediaSources:[]).filter(media=>media?.Id&&media.SupportsDirectPlay!==false);
    for(const media of mediaSources){const file=filename(item,media),display=foundation.streamDisplayFromFilename(file),q=quality(media,display);out.push({rank:q.rank,stream:{name:display.name,description:description(display,media),url:directUrl(source,item.Id,media.Id,playback?.PlaySessionId||''),behaviorHints:{notWebReady:true,bingeGroup:neutralGroup(type,videoId,file),filename:file,...(Number(media.Size)>0?{videoSize:Number(media.Size)}:{})}}});}
  }
  return out.sort((a,b)=>b.rank-a.rank).map(row=>row.stream);
}
async function streamsFor(entitlement,type,videoId){
  const args=parseVideoId(type,videoId);if(!args)return[];
  const sources=await sourcePool.enabledSourcesForEntitlement(entitlement);if(!sources.length)return[];
  // Resolve sources concurrently, but flatten in configured source-priority order.
  const settled=await Promise.allSettled(sources.map(source=>streamsFrom(source,args,type,videoId)));
  const output=[];
  for(let i=0;i<settled.length;i+=1){const result=settled[i],source=sources[i];if(result.status==='fulfilled'){output.push(...result.value);await query(`UPDATE stremio_sources SET last_success_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id=$1`,[source.id]).catch(()=>{});continue;}await query(`UPDATE stremio_sources SET auth_state=CASE WHEN $2 THEN 'reconnect_required' ELSE auth_state END,last_error=$3,updated_at=NOW() WHERE id=$1`,[source.id,result.reason?.code==='STREMIO_SOURCE_AUTH',String(result.reason?.message||result.reason).slice(0,1000)]).catch(()=>{});}
  return output;
}

module.exports={parseVideoId,filename,quality,description,directUrl,items,streamsFrom,streamsFor};
