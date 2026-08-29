'use strict';

const {query}=require('../db');
const capacity=require('../entitlements/plan-capacity');
const notificationSettings=require('../integrations/notification-settings');
const notificationOutbox=require('../integrations/notification-outbox');
const operations=require('../platform/operations-settings');

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
async function run({now=new Date(),settings=null,db=query,usage=capacity.usage,enqueue=notificationOutbox.enqueueDiscordChannel,operationsConfig=null}={}){
  const cfg=settings||await notificationSettings.status();
  if(!cfg.discordFreePlacesDigestEnabled)return{processed:0,queued:0,skipped:'disabled'};
  if(!cfg.discordConfigured)return{processed:0,queued:0,skipped:'discord_not_configured'};
  if(!cfg.discordFreePlacesChannelId)return{processed:0,queued:0,skipped:'channel_not_configured'};
  const due=dueSlot(cfg,now);
  if(!due)return{processed:0,queued:0,skipped:'not_due'};
  const plan=await freePlan(db);
  if(!plan)return{processed:1,queued:0,skipped:'free_plan_not_found'};
  const state=await usage(plan.id,db);
  if(state.remaining==null||!Number.isFinite(Number(state.remaining)))return{processed:1,queued:0,skipped:'remaining_unavailable'};
  const remaining=Math.max(0,Math.floor(Number(state.remaining))),minimum=Math.max(1,Number(cfg.discordFreePlacesMinRemaining)||1);
  if(remaining<minimum)return{processed:1,queued:0,remaining,skipped:'below_minimum'};
  const op=operationsConfig||await operations.get();
  const publicBaseUrl=String(op.publicBaseUrl||'').trim();
  if(!publicBaseUrl)return{processed:1,queued:0,remaining,skipped:'public_base_url_not_configured'};
  const dedupeKey=`free-places-digest:${cfg.discordFreePlacesChannelId}:${due.date}:${due.slot}`;
  const queued=await enqueue({eventType:'free-places-digest',text:digestText(remaining,publicBaseUrl),destination:cfg.discordFreePlacesChannelId,dedupeKey,allowEveryone:Boolean(cfg.discordFreePlacesMentionEveryone)});
  return{processed:1,queued:queued?.queued?1:0,remaining,dedupeKey,slot:due.slot};
}

module.exports={run,localStamp,dueSlot,freePlan,digestText};
