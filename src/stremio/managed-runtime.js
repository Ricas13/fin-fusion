'use strict';

const crypto=require('crypto');
const {query}=require('../db');
const foundation=require('./foundation');
const jellyfin=require('./jellyfin-runtime');
const mediaIndex=require('./media-index');
const episodeResolution=require('./episode-resolution');
const managedEntitlements=require('./managed-entitlements');
const managedSources=require('./managed-sources');
const entitlements=require('./entitlements');
const sourceAdmission=require('./source-admission');

const MAX_STREAMING_BITRATE=200000000;
const DIRECT_CONTAINERS='mp4,m4v,mkv,webm,ts,m2ts,mov';
const DIRECT_AUDIO_CODECS='aac,mp3,ac3,eac3,opus,flac';
const VIDEO_CONTAINERS=new Set(['ts','webm','asf','wmv','ogv','mp4','m4v','mkv','mpeg','mpg','avi','3gp','wtv','m2ts','mov','iso','flv']);

function neutralGroup(type,videoId,filename){return `cf-${crypto.createHash('sha1').update(`${type}:${videoId}:${filename}`,'utf8').digest('hex').slice(0,16)}`;}
function containerExtension(value){const container=String(value||'').split(',')[0].trim().toLowerCase();return VIDEO_CONTAINERS.has(container)?container:'';}
function directUrl(mapping,itemId,mediaSourceId,playSessionId='',deviceId='',accessTokenOverride='',container=''){
  const base=String(mapping.public_url||'').replace(/\/$/,'');if(!base)throw new Error('Managed Jellyfin public URL is missing.');
  const extension=containerExtension(container),url=new URL(`${base}/Videos/${encodeURIComponent(String(itemId))}/stream${extension?`.${extension}`:''}`);
  url.searchParams.set('Static','true');url.searchParams.set('MediaSourceId',String(mediaSourceId));
  const token=String(accessTokenOverride||'')||entitlements.accessToken({jellyfin_access_token_encrypted:mapping.access_token_encrypted});if(!token)throw new Error('Managed Stremio playback token is unavailable.');
  url.searchParams.set('api_key',token);if(playSessionId)url.searchParams.set('PlaySessionId',String(playSessionId));if(deviceId)url.searchParams.set('DeviceId',String(deviceId));return url.toString();
}
function admissionUrl({portalBase,installToken,mapping,itemId,mediaSourceId,playSessionId,lease}){
  const base=String(portalBase||'').replace(/\/$/,''),install=String(installToken||'').trim();if(!base||!install)throw new Error('Managed Stremio admission URL is unavailable.');
  const url=new URL(`/stremio/${encodeURIComponent(install)}/play/${encodeURIComponent(String(mapping.id))}/${encodeURIComponent(String(itemId))}/${encodeURIComponent(String(mediaSourceId))}`,`${base}/`);
  url.searchParams.set('lease',String(lease));if(playSessionId)url.searchParams.set('playSessionId',String(playSessionId));return url.toString();
}
function runtimeEntitlement(mapping){return{server_id:mapping.server_id,base_url:mapping.base_url,public_url:mapping.public_url,server_name:mapping.server_name,jellyfin_user_id:mapping.jellyfin_user_id,jellyfin_access_token_encrypted:mapping.access_token_encrypted};}
function stremioDeviceProfile(){return{
  Name:'CAPTAiNFiN Stremio',
  MaxStreamingBitrate:MAX_STREAMING_BITRATE,
  MaxStaticBitrate:MAX_STREAMING_BITRATE,
  DirectPlayProfiles:[{Type:'Video',Container:DIRECT_CONTAINERS,VideoCodec:'h264',AudioCodec:DIRECT_AUDIO_CODECS}],
  TranscodingProfiles:[{Type:'Video',Context:'Streaming',Protocol:'hls',Container:'ts',VideoCodec:'h264',AudioCodec:'aac,ac3,eac3,mp3',MaxAudioChannels:'8',MinSegments:1,SegmentLength:6,BreakOnNonKeyFrames:true}],
  ContainerProfiles:[],CodecProfiles:[],SubtitleProfiles:[]
};}
async function playbackInfo(mapping,itemId,mediaSourceId=null){
  const runtime=runtimeEntitlement(mapping),body={UserId:String(mapping.jellyfin_user_id),MaxStreamingBitrate:MAX_STREAMING_BITRATE,MaxAudioChannels:8,EnableDirectPlay:true,EnableDirectStream:true,EnableTranscoding:true,AllowVideoStreamCopy:true,AllowAudioStreamCopy:true,DeviceProfile:stremioDeviceProfile()};
  if(mediaSourceId)body.MediaSourceId=String(mediaSourceId);
  const qs=new URLSearchParams({UserId:String(mapping.jellyfin_user_id)});if(mediaSourceId)qs.set('MediaSourceId',String(mediaSourceId));
  return jellyfin.restrictedRequest(runtime,`/Items/${encodeURIComponent(String(itemId))}/PlaybackInfo?${qs.toString()}`,{method:'POST',body});
}
function mediaSource(playback,mediaSourceId){const id=String(mediaSourceId||'');const sources=Array.isArray(playback?.MediaSources)?playback.MediaSources:[];return sources.find(source=>source?.Id&&String(source.Id)===id)||null;}
function playMethodFor(source){
  if(!source?.Id)return null;
  if(source.SupportsDirectPlay!==false)return'DirectPlay';
  if(source.TranscodingUrl){if(source.SupportsDirectStream===true)return'DirectStream';if(source.SupportsTranscoding!==false)return'Transcode';}
  return'DirectPlay';
}
function publicTranscodingUrl(mapping,relativeUrl,{accessToken,playSessionId='',deviceId=''}){
  const internal=new URL(String(mapping.base_url||'')),candidate=new URL(String(relativeUrl||''),`${internal.toString().replace(/\/$/,'')}/`);if(candidate.origin!==internal.origin)throw new Error('Managed Jellyfin transcoding URL escaped the configured server origin.');
  const publicBase=new URL(String(mapping.public_url||''));
  const internalRoot=internal.pathname.replace(/\/+$/,''),publicRoot=publicBase.pathname.replace(/\/+$/,'');let relativePath=candidate.pathname;
  if(internalRoot&&internalRoot!=='/'&&(relativePath===internalRoot||relativePath.startsWith(`${internalRoot}/`)))relativePath=relativePath.slice(internalRoot.length)||'/';
  const targetPath=`${publicRoot&&publicRoot!=='/'?publicRoot:''}/${relativePath.replace(/^\/+/, '')}`||'/';const target=new URL(targetPath,publicBase.origin);target.search=candidate.search;
  target.searchParams.set('api_key',String(accessToken));if(playSessionId)target.searchParams.set('PlaySessionId',String(playSessionId));if(deviceId)target.searchParams.set('DeviceId',String(deviceId));return target.toString();
}
function playbackUrl(mapping,itemId,source,playback,{accessToken,deviceId=''}){
  const playSessionId=String(playback?.PlaySessionId||''),method=playMethodFor(source);if(!method)throw new Error('Managed Jellyfin media source is not playable.');
  if(method!=='DirectPlay'&&source.TranscodingUrl)return{url:publicTranscodingUrl(mapping,source.TranscodingUrl,{accessToken,playSessionId,deviceId}),playMethod:method,playSessionId};
  return{url:directUrl(mapping,itemId,source.Id,playSessionId,deviceId,accessToken,source.Container),playMethod:'DirectPlay',playSessionId};
}
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
  const playback=await playbackInfo(mapping,item.id);
  await query(`UPDATE stremio_managed_accounts SET last_playback_info_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id=$1`,[mapping.id]).catch(()=>{});
  const sources=(Array.isArray(playback?.MediaSources)?playback.MediaSources:[]).filter(source=>source?.Id);
  return sources.map(source=>{const filename=jellyfin.sourceFilename(item,source),quality=jellyfin.sourceQuality(source,filename),display=foundation.streamDisplayFromFilename(filename),lease=sourceAdmission.issue();return{rank:quality.rank,stream:{name:display.name,description:foundation.richStreamDescription(display,source),url:admissionUrl({portalBase:proxyBase,installToken,mapping,itemId:item.id,mediaSourceId:source.Id,playSessionId:playback?.PlaySessionId||'',lease}),behaviorHints:{notWebReady:true,bingeGroup:neutralGroup(type,videoId,filename),filename,...(Number(source.Size)>0?{videoSize:Number(source.Size)}:{})}}};}).sort((a,b)=>b.rank-a.rank);
}
async function mappingsForSearch(entitlement){
  try{return await managedEntitlements.mappings(entitlement);}
  catch(error){
    console.warn('Managed Stremio policy refresh failed; falling back to active persisted mappings:',String(error?.message||error).slice(0,500));
    return managedSources.accountsForEntitlement(entitlement.id);
  }
}
async function streamsFor(entitlement,type,videoId,options={}){
  const args=jellyfin.parseVideoId(type,videoId);if(!args)return[];const mappings=await mappingsForSearch(entitlement);if(!mappings.length)return[];
  const settled=await Promise.allSettled(mappings.map(mapping=>streamsFromMapping(mapping,args,type,videoId,options))),output=[];
  for(let index=0;index<settled.length;index+=1){const result=settled[index],mapping=mappings[index];if(result.status==='fulfilled'){output.push(...result.value.map(row=>row.stream));continue;}await query(`UPDATE stremio_managed_accounts SET last_error=$2,updated_at=NOW() WHERE id=$1`,[mapping.id,String(result.reason?.message||result.reason).slice(0,1000)]).catch(()=>{});console.warn(`Managed Stremio stream resolution failed on ${mapping.server_name}:`,result.reason?.message||result.reason);}
  return output;
}

module.exports={MAX_STREAMING_BITRATE,DIRECT_CONTAINERS,DIRECT_AUDIO_CODECS,neutralGroup,containerExtension,directUrl,admissionUrl,runtimeEntitlement,stremioDeviceProfile,playbackInfo,mediaSource,playMethodFor,publicTranscodingUrl,playbackUrl,resolveManagedItem,streamsFromMapping,mappingsForSearch,streamsFor};
