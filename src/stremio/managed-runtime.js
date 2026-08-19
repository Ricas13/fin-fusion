'use strict';

const crypto=require('crypto');
const {query}=require('../db');
const foundation=require('./foundation');
const jellyfin=require('./jellyfin-runtime');
const managedEntitlements=require('./managed-entitlements');
const entitlements=require('./entitlements');

function neutralGroup(type,videoId,filename){return `cf-${crypto.createHash('sha1').update(`${type}:${videoId}:${filename}`,'utf8').digest('hex').slice(0,16)}`;}
function directUrl(mapping,itemId,mediaSourceId,playSessionId=''){
  const base=String(mapping.public_url||'').replace(/\/$/,'');if(!base)throw new Error('Managed Jellyfin public URL is missing.');
  const url=new URL(`${base}/Videos/${encodeURIComponent(String(itemId))}/stream`);
  url.searchParams.set('Static','true');url.searchParams.set('MediaSourceId',String(mediaSourceId));
  const token=entitlements.accessToken({jellyfin_access_token_encrypted:mapping.access_token_encrypted});if(!token)throw new Error('Managed Stremio playback token is unavailable.');
  url.searchParams.set('api_key',token);if(playSessionId)url.searchParams.set('PlaySessionId',String(playSessionId));return url.toString();
}
function runtimeEntitlement(mapping){return{server_id:mapping.server_id,base_url:mapping.base_url,public_url:mapping.public_url,server_name:mapping.server_name,jellyfin_user_id:mapping.jellyfin_user_id,jellyfin_access_token_encrypted:mapping.access_token_encrypted};}
async function streamsFromMapping(mapping,args,type,videoId){
  const runtime=runtimeEntitlement(mapping),item=await jellyfin.resolveItem(runtime,args);if(!item)return[];
  const qs=new URLSearchParams({UserId:String(mapping.jellyfin_user_id)}),playback=await jellyfin.restrictedRequest(runtime,`/Items/${encodeURIComponent(item.id)}/PlaybackInfo?${qs.toString()}`);
  await query(`UPDATE stremio_managed_accounts SET last_playback_info_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id=$1`,[mapping.id]).catch(()=>{});
  const sources=(Array.isArray(playback?.MediaSources)?playback.MediaSources:[]).filter(source=>source?.Id&&source.SupportsDirectPlay!==false);
  return sources.map(source=>{const filename=jellyfin.sourceFilename(item,source),quality=jellyfin.sourceQuality(source,filename),display=foundation.streamDisplayFromFilename(filename);return{rank:quality.rank,stream:{name:display.name,description:jellyfin.streamDescription(quality,source),url:directUrl(mapping,item.id,source.Id,playback?.PlaySessionId||''),behaviorHints:{notWebReady:true,bingeGroup:neutralGroup(type,videoId,filename),filename,...(Number(source.Size)>0?{videoSize:Number(source.Size)}:{})}}};}).sort((a,b)=>b.rank-a.rank);
}
async function streamsFor(entitlement,type,videoId){
  const args=jellyfin.parseVideoId(type,videoId);if(!args)return[];const mappings=await managedEntitlements.mappings(entitlement);if(!mappings.length)return[];
  const settled=await Promise.allSettled(mappings.map(mapping=>streamsFromMapping(mapping,args,type,videoId))),output=[];
  for(let index=0;index<settled.length;index+=1){const result=settled[index],mapping=mappings[index];if(result.status==='fulfilled'){output.push(...result.value.map(row=>row.stream));continue;}await query(`UPDATE stremio_managed_accounts SET last_error=$2,updated_at=NOW() WHERE id=$1`,[mapping.id,String(result.reason?.message||result.reason).slice(0,1000)]).catch(()=>{});console.warn(`Managed Stremio stream resolution failed on ${mapping.server_name}:`,result.reason?.message||result.reason);}
  return output;
}

module.exports={neutralGroup,directUrl,runtimeEntitlement,streamsFromMapping,streamsFor};
