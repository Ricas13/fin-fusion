'use strict';

const {query,transaction}=require('../db');
const capacity=require('../entitlements/plan-capacity');
const notificationSettings=require('../integrations/notification-settings');
const discordMessage=require('../integrations/discord-message');
const operations=require('../platform/operations-settings');
const {FREE_INTENT_MINUTES}=require('../security/pending-registration');

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
function freeRegistrationUrl(publicBaseUrl){
  const base=String(publicBaseUrl||'').replace(/\/+$/,'');
  return base?`${base}/account/register?intent=free`:'';
}
function digestText(remaining,publicBaseUrl){
  const count=Math.max(0,Number(remaining)||0),noun=count===1?'place':'places',base=String(publicBaseUrl||'').replace(/\/+$/,'');
  return `Free Server — ${count} ${noun} open\n${count>0?freeRegistrationUrl(base):base}`;
}
function signupExplanation(open){
  return open
    ? `Starting signup opens a ${FREE_INTENT_MINUTES}-minute window to enter your details. It does not reserve a place. Capacity is checked atomically when valid account details are submitted.`
    : `Starting signup does not reserve a place. When capacity reopens, a ${FREE_INTENT_MINUTES}-minute signup window lets you enter your details; a place is reserved only after a valid submission.`;
}
function persistentText(remaining,publicBaseUrl){
  const count=Math.max(0,Math.floor(Number(remaining)||0)),base=String(publicBaseUrl||'').replace(/\/+$/,''),signupUrl=freeRegistrationUrl(base);
  if(count<=0)return `🔴 **Free Server availability**\nNo free places currently available.\n${base}\n\n${signupExplanation(false)}`;
  const noun=count===1?'place':'places';
  return `🟢 **Free Server availability**\n${count} free ${noun} currently available.\nStart Free Access signup: ${signupUrl}\n\n${signupExplanation(true)}`;
}
function persistentMessage(remaining,publicBaseUrl){
  const count=Math.max(0,Math.floor(Number(remaining)||0));
  const base=String(publicBaseUrl||'').replace(/\/+$/,'');
  const signupUrl=freeRegistrationUrl(base);
  const open=count>0;
  const noun=count===1?'place':'places';
  return discordMessage.card({
    title:`${open?'🟢':'🔴'} Free Server availability`,
    description:open
      ? `**${count} free ${noun}** currently available.`
      : 'No free places currently available.',
    tone:open?'success':'bad',
    fields:[{
      name:'How signup works',
      value:signupExplanation(open),
      inline:false
    }],
    url:open?signupUrl:base,
    footer:'CAPTAiN FiN • Newly freed places announced twice daily',
    buttonLabel:open?'Start Free Access signup':'View Free Server',
    buttonUrl:open?signupUrl:base
  });
}
function discordMissing(error){return /(?:HTTP|Discord)\s*404|unknown message/i.test(String(error?.message||error||''));}
function becameAvailable(previousRemaining,remaining){
  return previousRemaining===0&&Number(remaining)>0;
}
function advertSlotKey(cfg,now=new Date()){
  const due=dueSlot(cfg,now);
  return due?`${due.date}T${due.slot}`:null;
}
async function sendDiscordMessage({channelId,text,message=null,allowEveryone=false}){
  const channel=notificationSettings.snowflake(channelId);
  if(!channel)throw new Error('Discord channel ID is required.');
  return notificationSettings.discordApi(`/channels/${encodeURIComponent(channel)}/messages`,{method:'POST',body:discordMessage.body(message,{fallbackText:text,allowEveryone})});
}
async function loadState(db=query){
  const result=await db('SELECT setting_value FROM platform_settings WHERE setting_key=$1',[STATE_KEY]);
  const value=result.rows[0]?.setting_value||{};
  return{
    channelId:String(value.channelId||''),
    messageId:String(value.messageId||''),
    text:String(value.text||''),
    remaining:value.remaining==null?null:Number(value.remaining),
    observedRemaining:value.observedRemaining==null?null:Number(value.observedRemaining),
    lastAdvertSlot:value.lastAdvertSlot?String(value.lastAdvertSlot):null,
    updatedAt:value.updatedAt||null
  };
}
async function saveState(db,state){
  await db(`INSERT INTO platform_settings(setting_key,setting_value) VALUES($1,$2::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`,[STATE_KEY,JSON.stringify({...state,updatedAt:new Date().toISOString()})]);
}
async function editDiscordMessage({channelId,messageId,text,message=null}){
  const channel=notificationSettings.snowflake(channelId),messageIdSafe=notificationSettings.snowflake(messageId);
  if(!channel||!messageIdSafe)throw new Error('Discord channel/message ID is invalid.');
  return notificationSettings.discordApi(`/channels/${encodeURIComponent(channel)}/messages/${encodeURIComponent(messageIdSafe)}`,{method:'PATCH',body:discordMessage.body(message,{fallbackText:text,allowEveryone:false})});
}
async function deleteDiscordMessage({channelId,messageId}){
  const channel=notificationSettings.snowflake(channelId),messageIdSafe=notificationSettings.snowflake(messageId);
  if(!channel||!messageIdSafe)throw new Error('Discord channel/message ID is invalid.');
  return notificationSettings.discordApi(`/channels/${encodeURIComponent(channel)}/messages/${encodeURIComponent(messageIdSafe)}`,{method:'DELETE'});
}
async function syncPersistent({settings=null,usage=capacity.usage,operationsConfig=null,send=sendDiscordMessage,edit=editDiscordMessage,remove=deleteDiscordMessage,transactionFn=transaction,now=new Date()}={}){
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
    const capacityState=await usage(plan.id,db);
    if(capacityState.remaining==null||!Number.isFinite(Number(capacityState.remaining)))return{processed:1,updated:0,skipped:'remaining_unavailable'};

    const actualRemaining=Math.max(0,Math.floor(Number(capacityState.remaining)));
    const channelId=String(cfg.discordFreePlacesChannelId);
    const currentSlot=advertSlotKey(cfg,now);
    const minRemaining=Math.max(1,Number(cfg.discordFreePlacesMinRemaining)||1);
    let stored=await loadState(db);

    if(stored.channelId!==channelId){
      stored={channelId,messageId:'',text:'',remaining:null,observedRemaining:null,lastAdvertSlot:null,updatedAt:null};
    }

    // First install (or lost state) creates one canonical status message using
    // current capacity. This is setup/recovery, not a reopening notification.
    if(!stored.messageId){
      const initialMessage=persistentMessage(actualRemaining,publicBaseUrl);
      const sent=await send({channelId,text:persistentText(actualRemaining,publicBaseUrl),message:initialMessage,allowEveryone:false});
      const messageId=String(sent?.id||'');
      if(!messageId)throw new Error('Discord did not return an availability message ID.');
      await saveState(db,{
        channelId,
        messageId,
        text:JSON.stringify(initialMessage),
        remaining:actualRemaining,
        observedRemaining:actualRemaining,
        lastAdvertSlot:currentSlot
      });
      return{processed:1,updated:1,created:1,availabilityRestored:0,remaining:actualRemaining,observedRemaining:actualRemaining,messageId};
    }

    // Existing installations predate scheduled batching. Establish the current
    // slot as a baseline without generating a surprise fresh notification at
    // deploy time.
    if(!stored.lastAdvertSlot){
      stored.lastAdvertSlot=currentSlot;
    }

    const displayedRemaining=stored.remaining==null?actualRemaining:Math.max(0,Math.floor(Number(stored.remaining)||0));
    const slotAdvanced=Boolean(currentSlot&&stored.lastAdvertSlot!==currentSlot);
    const increaseBuffered=actualRemaining>displayedRemaining;
    const publishIncrease=Boolean(slotAdvanced&&increaseBuffered&&actualRemaining>=minRemaining);

    if(publishIncrease){
      try{await remove({channelId,messageId:stored.messageId});}
      catch(error){
        if(!discordMissing(error))console.warn('[free-places-digest] Failed to delete previous Discord availability message:',error?.message||error);
      }
      const message=persistentMessage(actualRemaining,publicBaseUrl);
      const sent=await send({channelId,text:persistentText(actualRemaining,publicBaseUrl),message,allowEveryone:false});
      const messageId=String(sent?.id||'');
      if(!messageId)throw new Error('Discord did not return an availability message ID.');
      await saveState(db,{
        channelId,
        messageId,
        text:JSON.stringify(message),
        remaining:actualRemaining,
        observedRemaining:actualRemaining,
        lastAdvertSlot:currentSlot
      });
      return{
        processed:1,updated:1,created:1,availabilityRestored:becameAvailable(displayedRemaining,actualRemaining)?1:0,
        advertised:1,remaining:actualRemaining,observedRemaining:actualRemaining,messageId
      };
    }

    // Availability may only move downward between advert slots. Any increase is
    // buffered in observedRemaining and released as one fresh POST at the next
    // configured slot. This avoids a notification storm when inactivity frees
    // several accounts over a short period.
    if(actualRemaining<displayedRemaining){
      const message=persistentMessage(actualRemaining,publicBaseUrl);
      let sent=null,created=false;
      try{sent=await edit({channelId,messageId:stored.messageId,text:persistentText(actualRemaining,publicBaseUrl),message});}
      catch(error){if(!discordMissing(error))throw error;}
      if(!sent){
        sent=await send({channelId,text:persistentText(actualRemaining,publicBaseUrl),message,allowEveryone:false});
        created=true;
      }
      const messageId=String(sent?.id||stored.messageId||'');
      if(!messageId)throw new Error('Discord did not return an availability message ID.');
      await saveState(db,{
        channelId,
        messageId,
        text:JSON.stringify(message),
        remaining:actualRemaining,
        observedRemaining:actualRemaining,
        lastAdvertSlot:slotAdvanced?currentSlot:stored.lastAdvertSlot
      });
      return{processed:1,updated:1,created:created?1:0,availabilityRestored:0,remaining:actualRemaining,observedRemaining:actualRemaining,messageId};
    }

    const stateChanged=stored.observedRemaining!==actualRemaining||slotAdvanced;
    if(stateChanged){
      await saveState(db,{
        channelId,
        messageId:stored.messageId,
        text:stored.text,
        remaining:displayedRemaining,
        observedRemaining:actualRemaining,
        lastAdvertSlot:slotAdvanced?currentSlot:stored.lastAdvertSlot
      });
    }
    return{
      processed:1,
      updated:0,
      remaining:displayedRemaining,
      observedRemaining:actualRemaining,
      messageId:stored.messageId,
      buffered:increaseBuffered,
      unchanged:!stateChanged
    };
  });
}
async function run(options={}){return syncPersistent(options);}

module.exports={STATE_KEY,run,syncPersistent,localStamp,dueSlot,advertSlotKey,freePlan,freeRegistrationUrl,digestText,persistentText,persistentMessage,signupExplanation,loadState,saveState,editDiscordMessage,deleteDiscordMessage,sendDiscordMessage,discordMissing,becameAvailable};