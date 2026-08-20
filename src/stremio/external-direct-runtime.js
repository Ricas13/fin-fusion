'use strict';

const {query}=require('../db');
const client=require('./source-client');
const sourceIndex=require('./source-index');
const planExternalSources=require('./plan-external-sources');
const episodeResolution=require('./episode-resolution');
const foundation=require('./foundation');
const sourceAdmission=require('./source-admission');
const {neutralGroup}=require('./managed-runtime');

function parseVideoId(type,videoId){if(type==='movie'){const imdb=sourceIndex.normalizeImdb(videoId);return imdb?{type:'movie',imdb}:null;}if(type!=='series')return null;const match=String(videoId||'').match(/^(tt\d{5,12}):(\d{1,3}):(\d{1,4})$/i);if(!match)return null;return{type:'series',imdb:match[1].toLowerCase(),season:Number(match[2]),episode:Number(match[3])};}
function basename(value){const raw=String(value||'').trim();if(!raw)return'';try{const parsed=new URL(raw);return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop()||'');}catch{return raw.split(/[\\/]/).pop()||'';}}
function filename(item,media){const itemPath=String(item?.Path||item?.path||''),mediaPath=String(media?.Path||'');const preferred=/\.strm(?:$|[?#])/i.test(itemPath)?itemPath:(mediaPath||itemPath);return basename(preferred)||`${item?.Name||item?.name||'video'}.mkv`;}
function quality(media,display){const meta=display.metadata||{},height=Number(media?.Height||media?.MediaStreams?.find(s=>s.Type==='Video')?.Height||0),bitrate=Number(media?.Bitrate||0);let rank=0;if(meta.resolution==='4K'||height>=2000)rank=400;if(meta.resolution==='1080p'||height>=1000&&height<2000)rank=Math.max(rank,300);if(meta.resolution==='720p'||height>=700&&height<1000)rank=Math.max(rank,200);if(meta.source==='REMUX')rank+=35;if(meta.source==='BluRay')rank+=20;if(meta.source==='WEB-DL')rank+=10;rank+=Math.min(20,bitrate/5000000);return{height,rank};}
function description(display,media){return foundation.richStreamDescription(display,media);}
function admissionUrl({portalBase,installToken,source,itemId,mediaSourceId,lease}){const base=String(portalBase||'').replace(/\/$/,''),install=String(installToken||'').trim(),media=String(mediaSourceId||'').trim();if(!base||!install||!source?.id||!media)throw new Error('External Stremio playback admission URL is unavailable.');const url=new URL(`/stremio/${encodeURIComponent(install)}/source/${encodeURIComponent(String(source.id))}/${encodeURIComponent(String(itemId))}/${encodeURIComponent(media)}`,`${base}/`);url.searchParams.set('lease',String(lease));return url.toString();}
async function roots(source,args){return sourceIndex.lookupAll(source.id,args.imdb,args.type);}
async function itemDetails(source,item){const qs=new URLSearchParams({Fields:'Path,MediaSources,MediaStreams',EnableImages:'false'}),detailed=await client.request(source,`/Users/${encodeURIComponent(String(source.jellyfin_user_id))}/Items/${encodeURIComponent(String(item.Id))}?${qs.toString()}`);return detailed&&detailed.Id?{...item,...detailed}:item;}
async function exactEpisode(source,row,args){
  const endpoint=episodeResolution.userItemsPath({userId:source.jellyfin_user_id,seriesId:row.item_id,season:args.season,episode:args.episode,fields:'Path,MediaSources,MediaStreams'}),payload=await client.request(source,endpoint),target=episodeResolution.pick(payload,args.season,args.episode);
  if(target)return target;
  const qs=new URLSearchParams({UserId:String(source.jellyfin_user_id),Season:String(args.season),Fields:'Path,MediaSources,MediaStreams',StartIndex:'0',Limit:'500',EnableImages:'false'}),legacy=await client.request(source,`/Shows/${encodeURIComponent(row.item_id)}/Episodes?${qs.toString()}`);
  return(Array.isArray(legacy?.Items)?legacy.Items:[]).find(item=>Number(item.IndexNumber)===args.episode&&Number(item.ParentIndexNumber??args.season)===args.season)||null;
}
async function items(source,args){const indexed=await roots(source,args);if(!indexed.length)return[];if(args.type==='movie')return Promise.all(indexed.map(async row=>itemDetails(source,{Id:row.item_id,Name:row.name,Path:row.path})));const settled=await Promise.allSettled(indexed.map(row=>exactEpisode(source,row,args)));return settled.filter(row=>row.status==='fulfilled'&&row.value).map(row=>row.value);}
function mediaSources(item){return(Array.isArray(item?.MediaSources)?item.MediaSources:[]).filter(media=>media?.Id&&media?.SupportsDirectPlay!==false);}
async function streamsFrom(source,args,type,videoId,{proxyBase,installToken}={}){const found=await items(source,args),out=[];for(const item of found){for(const media of mediaSources(item)){const file=filename(item,media),display=foundation.streamDisplayFromFilename(file),q=quality(media,display),lease=sourceAdmission.issue();out.push({rank:q.rank,stream:{name:display.name,description:description(display,media),url:admissionUrl({portalBase:proxyBase,installToken,source,itemId:item.Id,mediaSourceId:media.Id,lease}),behaviorHints:{notWebReady:true,bingeGroup:neutralGroup(type,videoId,file),filename:file,...(Number(media.Size)>0?{videoSize:Number(media.Size)}:{})}}});}}return out.sort((a,b)=>b.rank-a.rank).map(row=>row.stream);}
async function streamsFor(entitlement,type,videoId,options={}){const args=parseVideoId(type,videoId);if(!args)return[];const sources=await planExternalSources.forEntitlement(entitlement);if(!sources.length)return[];const settled=await Promise.allSettled(sources.map(source=>streamsFrom(source,args,type,videoId,options))),output=[];for(let i=0;i<settled.length;i+=1){const result=settled[i],source=sources[i];if(result.status==='fulfilled'){output.push(...result.value);await query(`UPDATE stremio_sources SET last_success_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id=$1`,[source.id]).catch(()=>{});continue;}await query(`UPDATE stremio_sources SET auth_state=CASE WHEN $2 THEN 'reconnect_required' ELSE auth_state END,last_error=$3,updated_at=NOW() WHERE id=$1`,[source.id,result.reason?.code==='STREMIO_SOURCE_AUTH',String(result.reason?.message||result.reason).slice(0,1000)]).catch(()=>{});}return output;}

module.exports={parseVideoId,filename,quality,description,admissionUrl,roots,itemDetails,exactEpisode,items,mediaSources,streamsFrom,streamsFor};
