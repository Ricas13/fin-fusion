'use strict';

const crypto=require('crypto');
const {query}=require('../db');
const foundation=require('./foundation');
const jellyfin=require('./jellyfin-runtime');
const mediaIndex=require('./media-index');
const episodeResolution=require('./episode-resolution');
const managedEntitlements=require('./managed-entitlements');
const entitlements=require('./entitlements');
const sourceAdmission=require('./source-admission');

function neutralGroup(type,videoId,filename){return `cf-${crypto.createHash('sha1').update(`${type}:${videoId}:${filename}`,'utf8').digest('hex').slice(0,16)}`;}
function directUrl(mapping,itemId,mediaSourceId,playSessionId='',deviceId=''){
  const base=String(mapping.public_url||'').replace(/\/$/,'');if(!base)throw new Error('Managed Jellyfin public URL is missing.');
  const url=new URL(`${base}/Videos/${encodeURIComponent(String(itemId))}/stream`);
  url.searchParams.set('Static','true');url.searchParams.set('MediaSourceId',String(mediaSourceId));
  const token=entitlements.accessToken({jellyfin_access_token_encrypted:mapping.access_token_encrypted});if(!token)throw new Error('Managed Stremio playback token is unavailable.');
  url.searchParams.set('api_key',token);if(playSessionId)url.searchParams.set('PlaySessionId',String(playSessionId));if(deviceId)url.searchParams.set('DeviceId',String(deviceId));return url.toString();
}
function admissionUrl({portalBase,installToken,mapping,itemId,mediaSourceId,playSessionId,lease}){
  const base=String(portalBase||'').replace(/\/$/,''),install=String(installToken||'').trim();if(!base||!install)throw new Error('Managed Stremio admission URL is unavailable.');
  const url=new URL(`/stremio/${encodeURIComponent(install)}/play/${encodeURIComponent(String(mapping.id))}/${encodeURIComponent(String(itemId))}/${encodeURIComponent(String(mediaSourceId))}`,`${base}/`);
  url.searchParams.set('lease',String(lease));if(playSessionId)url.searchParams.set('playSessionId',String(playSessionId));return url.toString();
}
function runtimeEntitlement(mapping){return{server_id:mapping.server_id,base_url:mapping.base_url,public_url:mapping.public_url,server_name:mapping.server_name,jellyfin_user_id:mapping.jellyfin_user_id,jellyfin_access_token_encrypted:mapping.access_token_encrypted};}
async function resolveManagedItem(mapping,runtime,args){
  const indexed=await mediaIndex.lookup(mapping.server_id,args.imdb,args.type);if(!indexed)return null;
  if(args.type==='movie')return{id:indexed.item_id,name:indexed.name,path:indexed.path,type:'Movie'};
  const endpoint=episodeResolution.userItemsPath({userId:mapping.jellyfin_user_id,seriesId:indexed.item_id,season:args.season,episode:args.episode,fields:'Path'});
  const payload=await jellyfin.restrictedRequest(runtime,endpoint),target=episodeResolution.pick(payload,args.season,args.episode);
  if(target)return{...target,id:String(target.Id),name:target.Name||indexed.name,path:target.Path||null,type:'Episode'};
  return jellyfin.resolveItem(runtime,args);
}
async function streamsFromMapping(mapping,args,type,videoId,{proxyBase,installToken}={}){
  const runtime=runtimeEntitlement(mapping),item=await resolveManagedItem(mapping,runtime,args);if(!item)return[];
  const qs=new URLSearchParams({UserId:String(mapping.jellyfin_user_id)}),playback=await jellyfin.restrictedRequest(runtime,`/Items/${encodeURIComponent(item.id)}/PlaybackInfo?${qs.toString()}`);
  await query(`UPDATE stremio_managed_accounts SET last_playback_info_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id=$1`,[mapping.id]).catch(()=>{});
  const sources=(Array.isArray(playback?.MediaSources)?playback.MediaSources:[]).filter(source=>source?.Id&&source.SupportsDirectPlay!==false);
  return sources.map(source=>{const filename=jellyfin.sourceFilename(item,source),quality=jellyfin.sourceQuality(source,filename),display=foundation.streamDisplayFromFilename(filename),lease=sourceAdmission.issue();return{rank:quality.rank,stream:{name:display.name,description:foundation.richStreamDescription(display,source),url:admissionUrl({portalBase:proxyBase,installToken,mapping,itemId:item.id,mediaSourceId:source.Id,playSessionId:playback?.PlaySessionId||'',lease}),behaviorHints:{notWebReady:true,bingeGroup:neutralGroup(type,videoId,filename),filename,...(Number(source.Size)>0?{videoSize:Number(source.Size)}:{})}}};}).sort((a,b)=>b.rank-a.rank);
}
async function streamsFor(entitlement,type,videoId,options={}){
  const args=jellyfin.parseVideoId(type,videoId);if(!args)return[];const mappings=await managedEntitlements.mappings(entitlement);if(!mappings.length)return[];
  const settled=await Promise.allSettled(mappings.map(mapping=>streamsFromMapping(mapping,args,type,videoId,options))),output=[];
  for(let index=0;index<settled.length;index+=1){const result=settled[index],mapping=mappings[index];if(result.status==='fulfilled'){output.push(...result.value.map(row=>row.stream));continue;}await query(`UPDATE stremio_managed_accounts SET last_error=$2,updated_at=NOW() WHERE id=$1`,[mapping.id,String(result.reason?.message||result.reason).slice(0,1000)]).catch(()=>{});console.warn(`Managed Stremio stream resolution failed on ${mapping.server_name}:`,result.reason?.message||result.reason);}
  return output;
}

module.exports={neutralGroup,directUrl,admissionUrl,runtimeEntitlement,resolveManagedItem,streamsFromMapping,streamsFor};
