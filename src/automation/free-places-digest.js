'use strict';

const {query,transaction}=require('../db');
const capacity=require('../entitlements/plan-capacity');
const notificationSettings=require('../integrations/notification-settings');
const operations=require('../platform/operations-settings');

const STATE_KEY='discord_free_places_status_v1';
const LOCK_SEED=927341;

function localStamp(now,timeZone){
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const value=type=>parts.find(part=>part.type===type)?.value||'';
  return{date:`${value('year')}-${value('month')}-${value('day')}`,time:`${value('hour')}:${value('minute')}`};
}
function dueSlot(cfg,now=new Date()){
  const stamp=localStamp(now,cfg.discordFreePlacesTimezone);
  const slot=[cfg.discordFreePlacesTime1,cfg.discordFreePlacesTime2].filter(Boolean).sort().reverse().find(value=>value<=stamp.time);
  return slot?{...stamp,slot}:null;
}
async function freePlan(db=query){
  const result=await db(`SELECT id FROM plans WHERE is_free_tier=TRUE AND service_type='jellyfin' AND COALESCE(is_addon,FALSE)=FALSE AND active=TRUE AND visible=TRUE AND archived_at IS NULL AND audience IN('direct','both') ORDER BY sort_order,price_minor LIMIT 1`);
  return result.rows[0]||null;
}
function digestText(remaining,publicBaseUrl){
  const count=Math.max(0,Number(remaining)||0),noun=count===1?'place':'places';
  return `Free Server — ${count} ${noun} open\n${String(publicBaseUrl||'').replace(/\/+$/,'')}`;
}
function persistentText(remaining,publicBaseUrl){
  const count=Math.max(0,Math.floor(Number(remaining)||0)),base=String(publicBaseUrl||'').replace(/\/+$/,'');
  if(count<=0)return `🔴 **Free Server availability**\nNo free places currently available.\n${base}\n\nA place becomes unavailable as soon as somebody reserves it. Unfinished reservations are released automatically after 10 minutes.`;
  const noun=count===1?'place':'places';
  return `🟢 **Free Server availability**\n${count} free ${noun} currently available.\nReserve / Create Free Account: ${base}\n\nPressing Reserve holds one place exclusively for 10 minutes while registration and email verification are completed.`;
}
function discordMissing(error){return /(?:HTTP|Discord)\s*404|unknown message/i.test(String(error?.message||error||''));}
async function loadState(db=query){
  const result=await db('SELECT setting_value FROM platform_settings WHERE setting_key=$1',[STATE_KEY]);
  const value=result.rows[0]?.setting_value||{};
  return{channelId:String(value.channelId||''),messageId:String(value.messageId||''),text:String(value.text||''),remaining:value.remaining==null?null:Number(value.remaining),updatedAt:value.updatedAt||null};
}
async function saveState(db,state){
  await db(`INSERT INTO platform_settings(setting_key,setting_value) VALUES($1,$2::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`,[STATE_KEY,JSON.stringify({...state,updatedAt:new Date().toISOString()})]);
}
async function editDiscordMessage({channelId,messageId,text}){
  const channel=notificationSettings.snowflake(channelId),message=notificationSettings.snowflake(messageId);
  if(!channel||!message)throw new Error('Discord channel/message ID is invalid.');
  return notificationSettings.discordApi(`/channels/${encodeURIComponent(channel)}/messages/${encodeURIComponent(message)}`,{method:'PATCH',body:{content:String(text||'').trim().slice(0,1900),allowed_mentions:{parse:[]}}});
}
async function syncPersistent({settings=null,usage=capacity.usage,operationsConfig=null,send=notificationSettings.sendDiscordChannel,edit=editDiscordMessage,transactionFn=transaction}={}){
  const cfg=settings||await notificationSettings.status();
  if(!cfg.discordFreePlacesDigestEnabled)return{processed:0,updated:0,skipped:'disabled'};
  if(!cfg.discordConfigured)return{processed:0,updated:0,skipped:'discord_not_configured'};
  if(!cfg.discordFreePlacesChannelId)return{processed:0,updated:0,skipped:'channel_not_configured'};
  const op=operationsConfig||await operations.get();
  const publicBaseUrl=String(op.publicBaseUrl||'').trim();
  if(!publicBaseUrl)return{processed:0,updated:0,skipped:'public_base_url_not_configured'};

  return transactionFn(async client=>{
    const db=(sql,params)=>client.query(sql,params);
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('captainfin:discord-free-places-status',$1::bigint))`,[LOCK_SEED]);
    const plan=await freePlan(db);
    if(!plan)return{processed:1,updated:0,skipped:'free_plan_not_found'};
    const state=await usage(plan.id,db);
    if(state.remaining==null||!Number.isFinite(Number(state.remaining)))return{processed:1,updated:0,skipped:'remaining_unavailable'};
    const remaining=Math.max(0,Math.floor(Number(state.remaining))),text=persistentText(remaining,publicBaseUrl),channelId=String(cfg.discordFreePlacesChannelId);
    let stored=await loadState(db);
    if(stored.channelId!==channelId)stored={channelId,messageId:'',text:'',remaining:null,updatedAt:null};
    if(stored.messageId&&stored.text===text)return{processed:1,updated:0,remaining,messageId:stored.messageId,unchanged:true};

    let message=null,created=false;
    if(stored.messageId){
      try{message=await edit({channelId,messageId:stored.messageId,text});}
      catch(error){if(!discordMissing(error))throw error;}
    }
    if(!message){
      message=await send({channelId,text,allowEveryone:false});
      created=true;
    }
    const messageId=String(message?.id||stored.messageId||'');
    if(!messageId)throw new Error('Discord did not return an availability message ID.');
    await saveState(db,{channelId,messageId,text,remaining});
    return{processed:1,updated:1,created:created?1:0,remaining,messageId};
  });
}
async function run(options={}){return syncPersistent(options);}

module.exports={STATE_KEY,run,syncPersistent,localStamp,dueSlot,freePlan,digestText,persistentText,loadState,saveState,editDiscordMessage,discordMissing};
