'use strict';

const crypto=require('crypto');
const {query}=require('../db');
const foundation=require('./foundation');
const mediaServer=require('../jellyfin/registry').mediaProvider;
const jellyfin=require('./jellyfin-runtime');
const mediaIndex=require('./media-index');
const episodeResolution=require('./episode-resolution');
const managedEntitlements=require('./managed-entitlements');
const managedSources=require('./managed-sources');
const entitlements=require('./entitlements');

const VIDEO_CONTAINERS=new Set(['ts','webm','asf','wmv','ogv','mp4','m4v','mkv','mpeg','mpg','avi','3gp','wtv','m2ts','mov','iso','flv']);

function neutralGroup(type,videoId,filename){return `cf-${crypto.createHash('sha1').update(`${type}:${videoId}:${filename}`,'utf8').digest('hex').slice(0,16)}`;}
function containerExtension(value){const container=String(value||'').split(',')[0].trim().toLowerCase();return VIDEO_CONTAINERS.has(container)?container:'';}
function pathExtension(value){const raw=String(value||'').split(/[?#]/)[0].replace(/\.strm$/i,''),match=raw.match(/\.([a-z0-9]{2,5})$/i);return match&&VIDEO_CONTAINERS.has(match[1].toLowerCase())?match[1].toLowerCase():'';}

function directUrl(mapping,itemId,mediaSourceId='',accessTokenOverride='',container='',filename=''){
  const base=String(mapping.public_url||'').replace(/\/$/,'');if(!base)throw new Error('Managed media-server public URL is missing.');
  const extension=containerExtension(container)||pathExtension(filename),type=mediaServer.normalizeType(mapping.media_server_type),url=mediaServer.apiUrl(base,type,`/Videos/${encodeURIComponent(String(itemId))}/stream${extension?`.${extension}`:''}`);
  url.searchParams.set('Static','true');
  if(mediaSourceId)url.searchParams.set('MediaSourceId',String(mediaSourceId));
  const token=String(accessTokenOverride||'')||entitlements.accessToken({jellyfin_access_token_encrypted:mapping.access_token_encrypted});if(!token)throw new Error('Managed Stremio raw-file token is unavailable.');
  url.searchParams.set('api_key',token);
  return url.toString();
}

function runtimeEntitlement(mapping){return{server_id:mapping.server_id,base_url:mapping.base_url,public_url:mapping.public_url,server_name:mapping.server_name,media_server_type:mapping.media_server_type,jellyfin_user_id:mapping.jellyfin_user_id,jellyfin_access_token_encrypted:mapping.access_token_encrypted};}
async function itemDetails(mapping,runtime,item){const id=String(item?.id||item?.Id||'');if(!id)return item;const qs=new URLSearchParams({Fields:'Path,MediaSources,MediaStreams',EnableImages:'false',EnableUserData:'false'}),detailed=await jellyfin.restrictedRequest(runtime,`/Users/${encodeURIComponent(String(mapping.jellyfin_user_id))}/Items/${encodeURIComponent(id)}?${qs.toString()}`);if(!detailed?.Id)return item;return{...item,...detailed,id:String(detailed.Id),name:detailed.Name||item.name||item.Name,path:detailed.Path||item.path||item.Path||null};}
function mediaSources(item){const sources=(Array.isArray(item?.MediaSources)?item.MediaSources:[]).filter(source=>source?.Id);if(sources.length)return sources;return[{Id:'',Path:item?.Path||item?.path||'',Container:pathExtension(item?.Path||item?.path||''),MediaStreams:[],Size:null,Bitrate:null}];}
async function resolveManagedItems(mapping,runtime,args){const indexedRows=await mediaIndex.lookupAll(mapping.server_id,args.imdb,args.type);if(!indexedRows.length)return[];if(args.type==='movie')return indexedRows.map(indexed=>({id:String(indexed.item_id),name:indexed.name,path:indexed.path,type:'Movie'}));const settled=await Promise.allSettled(indexedRows.map(async indexed=>{const endpoint=episodeResolution.userItemsPath({userId:mapping.jellyfin_user_id,seriesId:indexed.item_id,season:args.season,episode:args.episode,fields:'Path,MediaSources,MediaStreams'}),payload=await jellyfin.restrictedRequest(runtime,endpoint),target=episodeResolution.pick(payload,args.season,args.episode);return target?{...target,id:String(target.Id),name:target.Name||indexed.name,path:target.Path||null,type:'Episode'}:null;}));const items=settled.filter(result=>result.status==='fulfilled'&&result.value).map(result=>result.value),seen=new Set(),unique=[];for(const item of items){if(seen.has(String(item.id)))continue;seen.add(String(item.id));unique.push(item);}if(unique.length)return unique;const fallback=await jellyfin.resolveItem(runtime,args);return fallback?[{...fallback,id:String(fallback.id||fallback.Id),name:fallback.name||fallback.Name,path:fallback.path||fallback.Path||null,type:'Episode'}]:[];}
async function resolveManagedItem(mapping,runtime,args){return(await resolveManagedItems(mapping,runtime,args))[0]||null;}
async function streamsFromMapping(mapping,args,type,videoId){const runtime=runtimeEntitlement(mapping),items=await resolveManagedItems(mapping,runtime,args);if(!items.length)return[];const settled=await Promise.allSettled(items.map(async original=>{const item=await itemDetails(mapping,runtime,original),sources=mediaSources(item);return sources.map(source=>{const filename=jellyfin.sourceFilename(item,source),quality=jellyfin.sourceQuality(source,filename),display=foundation.streamDisplayFromFilename(filename);return{rank:quality.rank,stream:{name:display.name,description:foundation.richStreamDescription(display,source),url:directUrl(mapping,item.id,source.Id,'',source.Container,filename),behaviorHints:{notWebReady:true,bingeGroup:neutralGroup(type,videoId,`${item.id}:${source.Id||'file'}:${filename}`),filename,...(Number(source.Size)>0?{videoSize:Number(source.Size)}:{})}}};});}));const output=[],failures=[];let successfulItems=0;for(const result of settled){if(result.status==='fulfilled'){successfulItems+=1;output.push(...result.value);}else failures.push(result.reason);}if(successfulItems)await query(`UPDATE stremio_managed_accounts SET last_playback_info_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id=$1`,[mapping.id]).catch(()=>{});if(!successfulItems&&failures.length)throw failures[0];for(const error of failures)console.warn(`Managed Stremio raw-file resolution failed for one matching item on ${mapping.server_name}:`,error?.message||error);return output.sort((a,b)=>b.rank-a.rank);}
async function mappingsForSearch(entitlement){try{return await managedEntitlements.mappings(entitlement);}catch(error){console.warn('Managed Stremio policy refresh failed; falling back to active persisted mappings:',String(error?.message||error).slice(0,500));return managedSources.accountsForEntitlement(entitlement.id);}}
async function streamsFor(entitlement,type,videoId){const args=jellyfin.parseVideoId(type,videoId);if(!args)return[];const mappings=await mappingsForSearch(entitlement);if(!mappings.length)return[];const settled=await Promise.allSettled(mappings.map(mapping=>streamsFromMapping(mapping,args,type,videoId))),output=[];for(let index=0;index<settled.length;index+=1){const result=settled[index],mapping=mappings[index];if(result.status==='fulfilled'){output.push(...result.value.map(row=>row.stream));continue;}await query(`UPDATE stremio_managed_accounts SET last_error=$2,updated_at=NOW() WHERE id=$1`,[mapping.id,String(result.reason?.message||result.reason).slice(0,1000)]).catch(()=>{});console.warn(`Managed Stremio raw stream resolution failed on ${mapping.server_name}:`,result.reason?.message||result.reason);}return output;}

module.exports={neutralGroup,containerExtension,pathExtension,directUrl,runtimeEntitlement,itemDetails,mediaSources,resolveManagedItems,resolveManagedItem,streamsFromMapping,mappingsForSearch,streamsFor};
