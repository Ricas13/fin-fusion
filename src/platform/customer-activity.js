'use strict';
const express=require('express');
const {query}=require('../db');
const runtimeSettings=require('./runtime-settings');
const inactivityStatus=require('../automation/customer-inactivity-status');
const customers=require('../customers');
const customerNav=require('./customer-nav-html');
const registry=require('../jellyfin/registry');

const RANGE_OPTIONS=Object.freeze([
  {key:'7d',label:'7 days',days:7,bucket:'day'},
  {key:'30d',label:'30 days',days:30,bucket:'day'},
  {key:'90d',label:'3 months',days:90,bucket:'week'},
  {key:'180d',label:'6 months',days:180,bucket:'week'},
  {key:'365d',label:'1 year',days:365,bucket:'month'},
  {key:'ytd',label:'YTD',days:null,bucket:'month'},
  {key:'all',label:'All time',days:null,bucket:'month'}
]);

function requireCustomer(req,res,next){return req.session?.customerId&&req.session?.customerUserId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account/activity'));}
function rangeOption(raw){return RANGE_OPTIONS.find(option=>option.key===String(raw||''))||RANGE_OPTIONS[1];}
function utcDayStart(value){const d=new Date(value);return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()));}
function rangeStart(option,now=new Date()){
  if(option.key==='all')return null;
  if(option.key==='ytd')return new Date(Date.UTC(now.getUTCFullYear(),0,1));
  const start=utcDayStart(now);
  start.setUTCDate(start.getUTCDate()-(option.days-1));
  return start;
}
function previousRange(startAt,now=new Date()){
  if(!startAt)return{start:null,end:null};
  const span=Math.max(86400000,now.getTime()-startAt.getTime());
  return{start:new Date(startAt.getTime()-span),end:startAt};
}
function safeDurationSql(alias='ph'){return `LEAST(43200,GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(${alias}.ended_at,${alias}.last_seen_at)-${alias}.started_at))))`;}
function number(value){const parsed=Number(value);return Number.isFinite(parsed)?parsed:0;}
function percentChange(current,previous){const a=number(current),b=number(previous);if(b<=0)return a>0?100:0;return Math.round(((a-b)/b)*100);}
function publicItemImage(publicUrl,itemId){
  if(!publicUrl||!itemId)return null;
  try{
    const base=new URL(String(publicUrl));
    if(!['http:','https:'].includes(base.protocol)||base.username||base.password)return null;
    return `${base.toString().replace(/\/$/,'')}/Items/${encodeURIComponent(String(itemId))}/Images/Primary?maxHeight=96&quality=82`;
  }catch{return null;}
}
function platformLabel(device,client){
  const text=`${device||''} ${client||''}`.toLowerCase();
  if(/shield/.test(text))return'NVIDIA Shield';
  if(/apple tv|appletv/.test(text))return'Apple TV';
  if(/iphone|ipad|ios/.test(text))return'iOS (iPhone/iPad)';
  if(/fire tv|firetv|aft/.test(text))return'Amazon Fire TV';
  if(/roku/.test(text))return'Roku';
  if(/webos|\blg\b/.test(text))return'LG TV';
  if(/tizen|samsung/.test(text))return'Samsung TV';
  if(/android tv|google tv/.test(text))return'Android TV';
  if(/android/.test(text))return'Android (Mobile)';
  if(/chrome|firefox|safari|edge|browser|web client/.test(text))return'Web Browser';
  return String(device||client||'Other device');
}
function platformIcon(label){
  if(/shield|tv|roku|fire/i.test(label))return'tv';
  if(/iphone|ipad|android \(mobile\)/i.test(label))return'mobile';
  if(/browser/i.test(label))return'web';
  return'device';
}
function aggregatePlatforms(rows){
  const map=new Map();
  for(const row of rows){
    const label=platformLabel(row.device_name,row.client_name),entry=map.get(label)||{label,seconds:0,plays:0};
    entry.seconds+=number(row.seconds);entry.plays+=number(row.plays);map.set(label,entry);
  }
  const values=[...map.values()].sort((a,b)=>b.seconds-a.seconds||b.plays-a.plays);
  const total=Math.max(1,values.reduce((sum,row)=>sum+row.seconds,0));
  return values.slice(0,6).map(row=>({label:row.label,icon:platformIcon(row.label),plays:row.plays,hours:Math.round((row.seconds/3600)*10)/10,percent:Math.round((row.seconds/total)*100)}));
}
function heatmap(rows){
  const cellMap=new Map(rows.map(row=>[`${number(row.day)}:${number(row.hour)}`,number(row.seconds)]));
  const max=Math.max(0,...cellMap.values());
  const dayNames=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  return dayNames.map((label,index)=>({
    label,
    cells:Array.from({length:24},(_,hour)=>{
      const seconds=cellMap.get(`${index+1}:${hour}`)||0;
      return{hour,seconds,level:seconds<=0||max<=0?0:Math.max(1,Math.ceil((seconds/max)*4))};
    })
  }));
}
function formatHour(hour){const h=((Number(hour)%24)+24)%24;if(h===0)return'12am';if(h===12)return'12pm';return h<12?`${h}am`:`${h-12}pm`;}
function peakWindow(hourRows){
  const byHour=Array(24).fill(0);for(const row of hourRows)byHour[number(row.hour)]+=number(row.seconds);
  let bestStart=0,best=-1;
  for(let start=0;start<=20;start++){const total=byHour.slice(start,start+4).reduce((sum,value)=>sum+value,0);if(total>best){best=total;bestStart=start;}}
  return best>0?`${formatHour(bestStart)}–${formatHour((bestStart+4)%24)}`:'No peak yet';
}
function fillDailyTimeline(rows,startAt,now){
  const byDay=new Map(rows.map(row=>[utcDayStart(row.bucket).toISOString().slice(0,10),row]));
  const out=[];
  for(let day=utcDayStart(startAt);day<=utcDayStart(now);day=new Date(day.getTime()+86400000)){
    const key=day.toISOString().slice(0,10),row=byDay.get(key)||{};
    out.push({bucket:new Date(day),plays:number(row.plays),hours:Math.round((number(row.seconds)/3600)*10)/10});
  }
  return out;
}
function metadataItems(payload){return Array.isArray(payload)?payload:Array.isArray(payload?.Items)?payload.Items:Array.isArray(payload?.items)?payload.items:[];}
async function metadataForRows(rows){
  const groups=new Map();
  for(const row of rows){
    if(!row.server_id||!row.item_id)continue;
    const key=`${row.server_id}|${row.jellyfin_user_id||''}`;
    if(!groups.has(key))groups.set(key,{serverId:row.server_id,userId:row.jellyfin_user_id||null,ids:new Set()});
    groups.get(key).ids.add(String(row.item_id));
  }
  const metadata=new Map();
  await Promise.all([...groups.values()].map(async group=>{
    const ids=[...group.ids].slice(0,40);if(!ids.length)return;
    const fields='Genres,CommunityRating,ProductionYear,ParentIndexNumber,IndexNumber,SeriesName,RunTimeTicks,UserData';
    const endpoint=group.userId
      ? `/Users/${encodeURIComponent(group.userId)}/Items?Ids=${encodeURIComponent(ids.join(','))}&Fields=${encodeURIComponent(fields)}&Limit=${ids.length}`
      : `/Items?Ids=${encodeURIComponent(ids.join(','))}&Fields=${encodeURIComponent(fields)}&Limit=${ids.length}`;
    try{
      const payload=await registry.request(group.serverId,endpoint,{timeoutMs:5000,cacheTtlMs:60000});
      for(const item of metadataItems(payload)){if(item?.Id)metadata.set(`${group.serverId}|${String(item.Id).toLowerCase()}`,item);}
    }catch(error){console.warn('Customer activity metadata enrichment unavailable:',{serverId:group.serverId,error:error.message});}
  }));
  return metadata;
}
function rowMetadata(row,metadata){return row?.item_id?metadata.get(`${row.server_id}|${String(row.item_id).toLowerCase()}`)||null:null;}
function genreSummary(rows,metadata){
  const totals=new Map();
  for(const row of rows){
    const meta=rowMetadata(row,metadata),genres=Array.isArray(meta?.Genres)?meta.Genres.map(String).filter(Boolean).slice(0,5):[];
    if(!genres.length)continue;
    const share=number(row.seconds)/genres.length;
    for(const genre of genres)totals.set(genre,(totals.get(genre)||0)+share);
  }
  const sorted=[...totals.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8),sum=Math.max(1,sorted.reduce((total,row)=>total+row[1],0));
  return sorted.map(([name,seconds])=>({name,percent:Math.max(1,Math.round((seconds/sum)*100))}));
}
function averageRating(rows,metadata){
  const seen=new Set(),ratings=[];
  for(const row of rows){
    const key=`${row.server_id}|${row.item_id||''}`;if(seen.has(key))continue;seen.add(key);
    const rating=number(rowMetadata(row,metadata)?.CommunityRating);if(rating>0&&rating<=10)ratings.push(rating);
  }
  if(!ratings.length)return null;
  return Math.round((ratings.reduce((sum,value)=>sum+value,0)/ratings.length)*10)/10;
}
function recentWatching(rows,metadata){
  return rows.slice(0,5).map(row=>{
    const meta=rowMetadata(row,metadata),episode=String(row.item_type||'').toLowerCase()==='episode';
    const season=Number(meta?.ParentIndexNumber),episodeNo=Number(meta?.IndexNumber),series=meta?.SeriesName||null,year=meta?.ProductionYear||null;
    const runtimeTicks=number(meta?.RunTimeTicks),userProgress=number(meta?.UserData?.PlayedPercentage),durationSeconds=number(row.duration_seconds);
    let progress=null;
    if(userProgress>0)progress=Math.max(0,Math.min(100,Math.round(userProgress)));
    else if(runtimeTicks>0&&durationSeconds>0)progress=Math.max(1,Math.min(100,Math.round((durationSeconds/(runtimeTicks/10000000))*100)));
    const episodeBits=[];if(Number.isFinite(season))episodeBits.push(`S${season}`);if(Number.isFinite(episodeNo))episodeBits.push(`E${episodeNo}`);if(row.item_name)episodeBits.push(row.item_name);
    return{
      title:episode&&series?series:(row.item_name||'Unknown item'),
      subtitle:episode?episodeBits.join(' · '):[row.item_type||'Media',year].filter(Boolean).join(' · '),
      lastSeenAt:row.last_seen_at||row.started_at,
      progress,
      imageUrl:publicItemImage(row.public_url,row.item_id)
    };
  });
}
function summaryFrom(row){
  const seconds=number(row?.seconds),sessions=number(row?.sessions);
  return{watchHours:Math.round((seconds/3600)*10)/10,watchSeconds:seconds,titlesWatched:number(row?.titles_watched),episodesWatched:number(row?.episodes_watched),sessions,activeDays:number(row?.active_days),averageMinutes:sessions?Math.round((seconds/60)/sessions):0,lastPlayback:row?.last_playback||null};
}
async function insightData(customerId,rawRange){
  const now=new Date(),range=rangeOption(rawRange),startAt=rangeStart(range,now),previous=previousRange(startAt,now),duration=safeDurationSql('ph');
  const params=[customerId,startAt?startAt.toISOString():null];
  const predicate=`ph.customer_id=$1 AND ($2::timestamptz IS NULL OR COALESCE(ph.last_seen_at,ph.started_at)>=$2::timestamptz)`;
  const summarySql=`SELECT COUNT(*)::int sessions,COALESCE(SUM(${duration}),0) seconds,COUNT(DISTINCT COALESCE(NULLIF(ph.item_id,''),NULLIF(ph.item_name,''),ph.playback_key))::int titles_watched,COUNT(*) FILTER (WHERE lower(COALESCE(ph.item_type,''))='episode')::int episodes_watched,COUNT(DISTINCT DATE(ph.started_at))::int active_days,MAX(COALESCE(ph.last_seen_at,ph.started_at)) last_playback FROM playback_history ph WHERE ph.customer_id=$1 AND ($2::timestamptz IS NULL OR COALESCE(ph.last_seen_at,ph.started_at)>=$2::timestamptz) AND ($3::timestamptz IS NULL OR COALESCE(ph.last_seen_at,ph.started_at)<$3::timestamptz)`;
  const previousParams=[customerId,previous.start?previous.start.toISOString():null,previous.end?previous.end.toISOString():null];
  const bucket=range.bucket;
  const [summaryResult,previousResult,topResult,deviceResult,timelineResult,heatResult,recentResult]=await Promise.all([
    query(summarySql,[customerId,startAt?startAt.toISOString():null,null]),
    previous.start?query(summarySql,previousParams):Promise.resolve({rows:[{}]}),
    query(`SELECT ph.server_id,ph.item_id,ph.item_name,ph.item_type,ja.jellyfin_user_id,js.public_url,COUNT(*)::int plays,COALESCE(SUM(${duration}),0) seconds FROM playback_history ph JOIN jellyfin_servers js ON js.id=ph.server_id LEFT JOIN jellyfin_accounts ja ON ja.id=ph.jellyfin_account_id WHERE ${predicate} GROUP BY ph.server_id,ph.item_id,ph.item_name,ph.item_type,ja.jellyfin_user_id,js.public_url ORDER BY seconds DESC,plays DESC LIMIT 24`,params),
    query(`SELECT ph.device_name,ph.client_name,COUNT(*)::int plays,COALESCE(SUM(${duration}),0) seconds FROM playback_history ph WHERE ${predicate} GROUP BY ph.device_name,ph.client_name ORDER BY seconds DESC LIMIT 50`,params),
    query(`SELECT date_trunc('${bucket}',ph.started_at) bucket,COALESCE(SUM(${duration}),0) seconds,COUNT(*)::int plays FROM playback_history ph WHERE ${predicate} GROUP BY 1 ORDER BY 1 ASC`,params),
    query(`SELECT EXTRACT(ISODOW FROM ph.started_at)::int day,EXTRACT(HOUR FROM ph.started_at)::int hour,COALESCE(SUM(${duration}),0) seconds FROM playback_history ph WHERE ${predicate} GROUP BY 1,2 ORDER BY 1,2`,params),
    query(`SELECT * FROM (SELECT DISTINCT ON (ph.server_id,COALESCE(NULLIF(ph.item_id,''),ph.playback_key)) ph.server_id,ph.item_id,ph.item_name,ph.item_type,ph.started_at,ph.last_seen_at,ph.ended_at,${duration} duration_seconds,ja.jellyfin_user_id,js.public_url FROM playback_history ph JOIN jellyfin_servers js ON js.id=ph.server_id LEFT JOIN jellyfin_accounts ja ON ja.id=ph.jellyfin_account_id WHERE ${predicate} ORDER BY ph.server_id,COALESCE(NULLIF(ph.item_id,''),ph.playback_key),COALESCE(ph.last_seen_at,ph.started_at) DESC) recent ORDER BY COALESCE(last_seen_at,started_at) DESC LIMIT 20`,params)
  ]);
  recentResult.rows.sort((a,b)=>new Date(b.last_seen_at||b.started_at)-new Date(a.last_seen_at||a.started_at));
  const metadataRows=[...topResult.rows,...recentResult.rows],metadata=await metadataForRows(metadataRows),genres=genreSummary(topResult.rows,metadata),rating=averageRating(topResult.rows,metadata);
  const summary=summaryFrom(summaryResult.rows[0]||{}),prior=summaryFrom(previousResult.rows[0]||{}),platforms=aggregatePlatforms(deviceResult.rows),hourRows=[];
  for(const row of heatResult.rows){const hour=number(row.hour),entry=hourRows.find(item=>item.hour===hour);if(entry)entry.seconds+=number(row.seconds);else hourRows.push({hour,seconds:number(row.seconds)});}
  let timeline=timelineResult.rows.map(row=>({bucket:row.bucket,plays:number(row.plays),hours:Math.round((number(row.seconds)/3600)*10)/10}));
  if(range.bucket==='day'&&startAt)timeline=fillDailyTimeline(timelineResult.rows,startAt,now);
  return{
    range,
    rangeOptions:RANGE_OPTIONS,
    summary:{...summary,averageRating:rating},
    comparison:{watchTime:percentChange(summary.watchSeconds,prior.watchSeconds),titles:percentChange(summary.titlesWatched,prior.titlesWatched),episodes:percentChange(summary.episodesWatched,prior.episodesWatched),label:range.key==='30d'?'vs previous 30 days':'vs previous period',available:Boolean(previous.start)},
    genres,
    platforms,
    timeline,
    heatmap:heatmap(heatResult.rows),
    recent:recentWatching(recentResult.rows,metadata),
    peakTime:peakWindow(hourRows),
    insightCards:{
      watchTrend:percentChange(summary.watchSeconds,prior.watchSeconds),
      favoriteGenre:genres[0]?.name||null,
      peakTime:peakWindow(hourRows),
      deviceCount:new Set(deviceResult.rows.map(row=>platformLabel(row.device_name,row.client_name))).size
    }
  };
}
async function data(customerId,rawRange){
  const [activityRows,eventRows,freeUsage,portal,insights]=await Promise.all([
    query(`SELECT ph.started_at,ph.ended_at,ph.last_seen_at,ph.item_name,ph.item_type,ph.client_name,ph.device_name,ph.playback_method,js.name server_name FROM playback_history ph JOIN jellyfin_servers js ON js.id=ph.server_id WHERE ph.customer_id=$1 ORDER BY COALESCE(ph.last_seen_at,ph.started_at) DESC LIMIT 100`,[customerId]),
    query(`SELECT created_at,decision,reason,stream_limit,stream_count AS observed_streams FROM stream_policy_events WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100`,[customerId]),
    inactivityStatus.customerStatus(customerId).catch(()=>({applies:false,telemetry:{ready:false}})),
    customers.getCustomerPortal(customerId),
    insightData(customerId,rawRange)
  ]);
  const customer=portal?.customer||{};
  return{activity:activityRows.rows,events:eventRows.rows,freeUsage,insights,displayName:customer.display_name||customer.login_username||customer.username||null,navOptions:customerNav.optionsFromPortal(portal)};
}
function createCustomerActivityRouter(){
  const r=express.Router();
  r.get('/account/activity',requireCustomer,async(req,res,next)=>{try{await runtimeSettings.ensureLoaded();const d=await data(req.session.customerId,req.query.range);res.setHeader('Cache-Control','no-store, private, max-age=0');return res.render('customer/activity',{siteName:runtimeSettings.siteName(),...d});}catch(error){return next(error)}});
  return r;
}
module.exports={createCustomerActivityRouter,data,insightData,rangeOption,rangeStart,previousRange,heatmap,aggregatePlatforms,RANGE_OPTIONS};
