'use strict';

const crypto=require('crypto');
const {query}=require('../db');
const pool=require('./source-pool');
const gateway=require('./source-gateway');
const foundation=require('./foundation');

function parseVideoId(type,videoId){if(type==='movie'){const imdb=String(videoId||'').toLowerCase();return /^tt\d{5,12}$/.test(imdb)?{type:'movie',imdb}:null;}if(type!=='series')return null;const m=String(videoId||'').match(/^(tt\d{5,12}):(\d{1,3}):(\d{1,4})$/i);return m?{type:'series',imdb:m[1].toLowerCase(),season:Number(m[2]),episode:Number(m[3])}:null;}
function pickWeighted(rows){if(!rows.length)return null;const total=rows.reduce((n,r)=>n+Math.max(1,Number(r.weight||1)),0);let point=Math.random()*total;for(const row of rows){point-=Math.max(1,Number(row.weight||1));if(point<=0)return row;}return rows[rows.length-1];}
function orderedCandidates(rows,strategy){const unique=[],seen=new Set();for(const row of rows){if(!seen.has(row.source_id)){seen.add(row.source_id);unique.push(row);}}if(strategy==='priority')return unique.sort((a,b)=>Number(a.priority)-Number(b.priority));if(strategy==='random')return unique.sort(()=>Math.random()-.5);const pending=[...unique],ordered=[];while(pending.length){const pick=pickWeighted(pending),i=pending.indexOf(pick);ordered.push(pick);pending.splice(i,1);}return ordered;}
async function accountSecrets(sourceId){const r=await query('SELECT * FROM stremio_source_accounts WHERE source_id=$1 AND enabled=TRUE ORDER BY id',[sourceId]);return r.rows;}
async function resolveItem(source,account,indexed,args,deviceId){if(args.type==='movie')return{id:indexed.item_id,name:indexed.name,path:indexed.path,type:'Movie'};const qs=new URLSearchParams({UserId:String(account.jellyfin_user_id),Season:String(args.season),Fields:'Path,MediaSources,MediaStreams',StartIndex:'0',Limit:'500',EnableImages:'false'}),payload=await pool.request(source,account,`/Shows/${encodeURIComponent(indexed.item_id)}/Episodes?${qs.toString()}`,{deviceId});const items=Array.isArray(payload?.Items)?payload.Items:[],item=items.find(x=>Number(x.IndexNumber)===args.episode&&Number(x.ParentIndexNumber??args.season)===args.season);return item?{...item,id:String(item.Id),name:item.Name||indexed.name,path:item.Path||null,type:'Episode'}:null;}
function basename(value){const raw=String(value||'');if(!raw)return'';try{return decodeURIComponent(new URL(raw).pathname.split('/').filter(Boolean).pop()||'');}catch{return raw.split(/[\\/]/).pop()||'';}}
function filename(item,source){return basename(/\.strm(?:$|[?#])/i.test(String(item.path||''))?item.path:(source.Path||item.path||''))||`${item.name||'video'}.mkv`;}

async function streamsFor(entitlement,type,videoId){
  const args=parseVideoId(type,videoId);if(!args)return[];
  const candidates=await pool.lookup(args.imdb,args.type);if(!candidates.length)return null;
  const gate=await pool.admission(entitlement,videoId);if(!gate.allowed)return[];
  const cfg=await pool.settings(),ordered=orderedCandidates(candidates,cfg.strategy),deviceId=`cfst-${crypto.createHash('sha256').update(String(entitlement.id||entitlement.customer_id)).digest('hex').slice(0,20)}`;
  for(const indexed of ordered){
    const source={id:indexed.source_id,name:indexed.source_name,base_url:indexed.base_url,public_url:indexed.public_url};
    const accounts=await accountSecrets(source.id);if(!accounts.length)continue;const account=pickWeighted(accounts);
    try{
      const item=await resolveItem(source,account,indexed,args,deviceId);if(!item)continue;
      const qs=new URLSearchParams({UserId:String(account.jellyfin_user_id)}),playback=await pool.request(source,account,`/Items/${encodeURIComponent(item.id)}/PlaybackInfo?${qs.toString()}`,{deviceId}),mediaSources=(Array.isArray(playback?.MediaSources)?playback.MediaSources:[]).filter(x=>x&&x.Id&&x.SupportsDirectPlay!==false);
      if(!mediaSources.length)continue;
      await gateway.cleanupExpired(100).catch(()=>{});
      const streams=[];
      for(const media of mediaSources){
        const file=filename(item,media),display=foundation.streamDisplayFromFilename(file),grant=await gateway.issue({entitlement,source,account,itemId:item.id,mediaSourceId:media.Id,filename:file}),quality=display.metadata?.resolution||media.MediaStreams?.find(x=>x.Type==='Video')?.DisplayTitle||'Direct';
        streams.push({name:`[CF ⚡ ${source.name}] ${quality}`,description:`${display.description||'Direct Jellyfin stream'}\nSource: ${source.name}`,url:grant.url,behaviorHints:{notWebReady:true,filename:file}});
      }
      await query(`INSERT INTO stremio_stream_requests(entitlement_id,customer_id,source_id,source_account_id,video_id,imdb_id,item_type,item_id,media_source_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,[entitlement.id,entitlement.customer_id,source.id,account.id,String(videoId),args.imdb,args.type,item.id,String(mediaSources[0].Id),JSON.stringify({sourceName:source.name,bridgeAccount:account.label,deviceId,strategy:cfg.strategy,portalCustomerAttributed:true,upstreamVisibility:'bridge_account',credentialExposure:'opaque_gateway_grant'})]);
      return streams;
    }catch(error){console.warn(`Stremio source ${source.name} failed for ${videoId}:`,error.message);}
  }
  return null;
}

module.exports={streamsFor,parseVideoId,pickWeighted,orderedCandidates,resolveItem,filename};
