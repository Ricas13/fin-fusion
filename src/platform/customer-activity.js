'use strict';
const express=require('express');
const {query}=require('../db');
const runtimeSettings=require('./runtime-settings');
const inactivityStatus=require('../automation/customer-inactivity-status');
const customers=require('../customers');
const customerNav=require('./customer-nav-html');

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
function rangeStart(option,now=new Date()){
  if(option.key==='all')return null;
  if(option.key==='ytd')return new Date(Date.UTC(now.getUTCFullYear(),0,1));
  return new Date(now.getTime()-(option.days*86400000));
}
function safeDurationSql(alias='ph'){return `LEAST(43200,GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(${alias}.ended_at,${alias}.last_seen_at)-${alias}.started_at))))`;}
function number(value){const parsed=Number(value);return Number.isFinite(parsed)?parsed:0;}
function timeOfDay(rows){
  const periods=[
    {key:'morning',label:'Morning',detail:'06:00–11:59',hours:0},
    {key:'afternoon',label:'Afternoon',detail:'12:00–17:59',hours:0},
    {key:'evening',label:'Evening',detail:'18:00–23:59',hours:0},
    {key:'late',label:'Late night',detail:'00:00–05:59',hours:0}
  ];
  for(const row of rows){
    const hour=number(row.hour),hours=number(row.seconds)/3600;
    const target=hour<6?periods[3]:hour<12?periods[0]:hour<18?periods[1]:periods[2];
    target.hours+=hours;
  }
  const max=Math.max(0,...periods.map(period=>period.hours));
  periods.forEach(period=>{period.percent=max>0?Math.round((period.hours/max)*100):0;period.hours=Math.round(period.hours*10)/10;});
  return periods;
}
function viewingPersonality(periods){
  const top=[...periods].sort((a,b)=>b.hours-a.hours)[0];
  if(!top||top.hours<=0)return{title:'Your watch story is waiting',copy:'Once you start watching, your viewing pattern will appear here.'};
  const copy={morning:'You do most of your watching before midday.',afternoon:'Afternoons are your most-watched part of the day.',evening:'Prime time is your time — evenings lead your viewing.',late:'You are a night owl — most of your watch time lands after midnight.'};
  return{title:top.key==='late'?'Night owl':top.key==='evening'?'Prime-time watcher':top.key==='morning'?'Morning viewer':'Afternoon viewer',copy:copy[top.key]};
}
async function insightData(customerId,rawRange){
  const range=rangeOption(rawRange),startAt=rangeStart(range),duration=safeDurationSql('ph'),params=[customerId,startAt?startAt.toISOString():null];
  const predicate=`ph.customer_id=$1 AND ($2::timestamptz IS NULL OR COALESCE(ph.last_seen_at,ph.started_at)>=$2::timestamptz)`;
  const bucket=range.bucket;
  const [summaryResult,topResult,methodResult,deviceResult,timelineResult,hourResult,serverResult]=await Promise.all([
    query(`SELECT COUNT(*)::int sessions,COALESCE(SUM(${duration}),0) seconds,COUNT(DISTINCT DATE(ph.started_at))::int active_days,MIN(ph.started_at) first_playback,MAX(COALESCE(ph.last_seen_at,ph.started_at)) last_playback FROM playback_history ph WHERE ${predicate}`,params),
    query(`SELECT COALESCE(NULLIF(ph.item_name,''),'Unknown item') item_name,COALESCE(NULLIF(ph.item_type,''),'Media') item_type,COUNT(*)::int plays,COALESCE(SUM(${duration}),0) seconds FROM playback_history ph WHERE ${predicate} GROUP BY 1,2 ORDER BY seconds DESC,plays DESC,item_name ASC LIMIT 8`,params),
    query(`SELECT ph.playback_method,COUNT(*)::int plays,COALESCE(SUM(${duration}),0) seconds FROM playback_history ph WHERE ${predicate} GROUP BY ph.playback_method ORDER BY seconds DESC`,params),
    query(`SELECT COALESCE(NULLIF(ph.device_name,''),NULLIF(ph.client_name,''),'Unknown device') device,COUNT(*)::int plays,COALESCE(SUM(${duration}),0) seconds FROM playback_history ph WHERE ${predicate} GROUP BY 1 ORDER BY seconds DESC,plays DESC LIMIT 6`,params),
    query(`SELECT date_trunc('${bucket}',ph.started_at) bucket,COALESCE(SUM(${duration}),0) seconds,COUNT(*)::int plays FROM playback_history ph WHERE ${predicate} GROUP BY 1 ORDER BY 1 ASC`,params),
    query(`SELECT EXTRACT(HOUR FROM ph.started_at)::int hour,COALESCE(SUM(${duration}),0) seconds FROM playback_history ph WHERE ${predicate} GROUP BY 1 ORDER BY 1`,params),
    query(`SELECT js.name server_name,COUNT(*)::int plays,COALESCE(SUM(${duration}),0) seconds FROM playback_history ph JOIN jellyfin_servers js ON js.id=ph.server_id WHERE ${predicate} GROUP BY js.name ORDER BY seconds DESC,plays DESC LIMIT 1`,params)
  ]);
  const rawSummary=summaryResult.rows[0]||{},seconds=number(rawSummary.seconds),sessions=number(rawSummary.sessions),periods=timeOfDay(hourResult.rows);
  const summary={
    sessions,
    watchHours:Math.round((seconds/3600)*10)/10,
    activeDays:number(rawSummary.active_days),
    averageMinutes:sessions?Math.round((seconds/60)/sessions):0,
    firstPlayback:rawSummary.first_playback||null,
    lastPlayback:rawSummary.last_playback||null
  };
  const tops=topResult.rows.map(row=>({...row,plays:number(row.plays),hours:Math.round((number(row.seconds)/3600)*10)/10}));
  const methods=methodResult.rows.map(row=>({...row,plays:number(row.plays),hours:Math.round((number(row.seconds)/3600)*10)/10}));
  const methodTotal=Math.max(1,methods.reduce((sum,row)=>sum+number(row.seconds),0));
  methods.forEach(row=>{row.percent=Math.round((number(row.seconds)/methodTotal)*100);delete row.seconds;});
  const devices=deviceResult.rows.map(row=>({...row,plays:number(row.plays),hours:Math.round((number(row.seconds)/3600)*10)/10}));
  const timeline=timelineResult.rows.map(row=>({bucket:row.bucket,plays:number(row.plays),hours:Math.round((number(row.seconds)/3600)*10)/10}));
  return{
    range,
    rangeOptions:RANGE_OPTIONS,
    summary,
    topTitles:tops,
    playbackMethods:methods,
    devices,
    timeline,
    timeOfDay:periods,
    personality:viewingPersonality(periods),
    favoriteServer:serverResult.rows[0]?.server_name||null
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
async function nowPlaying(customerId){
  const result=await query(`SELECT aps.item_name,aps.item_type,aps.device_name,aps.client_name,aps.playback_method,aps.is_paused,aps.position_ticks,aps.last_seen_at,js.name server_name,COALESCE(js.media_server_type,'jellyfin') media_server_type FROM active_playback_sessions aps JOIN jellyfin_servers js ON js.id=aps.server_id WHERE aps.customer_id=$1 AND aps.last_seen_at>NOW()-INTERVAL '2 minutes' ORDER BY aps.last_seen_at DESC`,[customerId]);
  return result.rows.map(row=>({
    title:row.item_name||'Playing media',
    type:row.item_type||'Media',
    device:row.device_name||null,
    client:row.client_name||null,
    method:String(row.playback_method||'').toLowerCase()==='transcode'?'Transcoding':String(row.playback_method||'').toLowerCase()==='directstream'?'Direct stream':String(row.playback_method||'').toLowerCase()==='directplay'?'Direct play':null,
    paused:Boolean(row.is_paused),
    positionSeconds:Math.max(0,Math.floor(number(row.position_ticks)/10000000)),
    service:String(row.media_server_type||'jellyfin').toLowerCase()==='emby'?'Emby':(row.server_name||'Jellyfin')
  }));
}
function createCustomerActivityRouter(){
  const r=express.Router();
  r.get('/account/now-playing.json',requireCustomer,async(req,res)=>{
    res.setHeader('Cache-Control','no-store, private, max-age=0');
    res.setHeader('Pragma','no-cache');
    try{return res.json({streams:await nowPlaying(req.session.customerId)});}catch(error){console.warn('Customer now-playing lookup failed:',{customerId:req.session.customerId,error:error.message});return res.status(503).json({streams:[]});}
  });
  r.get('/account/activity',requireCustomer,async(req,res,next)=>{try{await runtimeSettings.ensureLoaded();const d=await data(req.session.customerId,req.query.range);res.setHeader('Cache-Control','no-store, private, max-age=0');return res.render('customer/activity',{siteName:runtimeSettings.siteName(),...d});}catch(error){return next(error)}});
  return r;
}
module.exports={createCustomerActivityRouter,data,insightData,nowPlaying,rangeOption,rangeStart,RANGE_OPTIONS};
