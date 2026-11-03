'use strict';

const {query,transaction}=require('../db');
const capacity=require('../entitlements/plan-capacity');
const notificationSettings=require('../integrations/notification-settings');
const discordMessage=require('../integrations/discord-message');
const operations=require('../platform/operations-settings');
const {FREE_INTENT_MINUTES}=require('../security/pending-registration');

const STATE_KEY='discord_free_places_status_v1';
const LOCK_SEED=927341;
const CANONICAL_VERIFY_INTERVAL_MS=5*60*1000;

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
// A deleted canonical message must not leave an older green availability card
// advertising sold-out places forever. Inspect at a bounded cadence.
async function inspectCanonical({channelId,messageId}){
  return notificationSettings.discordApi(`/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,{method:'GET',maxAttempts:1});
}
async function findOwnedStatusMessages({channelId}){
  const bot=await notificationSettings.discordApi('/users/@me',{method:'GET',maxAttempts:1});
  if(!bot?.id)throw new Error('Cannot identify Discord availability bot.');
  const messages=await notificationSettings.discordApi(`/channels/${encodeURIComponent(channelId)}/messages?limit=100`,{method:'GET',maxAttempts:1});
  if(!Array.isArray(messages))throw new Error('Discord availability history was not a list.');
  return messages.filter(message=>
    String(message?.author?.id||'')===String(bot.id) &&
    (message.embeds||[]).some(embed=>/^(?:🟢|🔴) Free Server availability$/u.test(String(embed?.title||'')))
  );
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
    lastVerifiedAt:value.lastVerifiedAt||null,
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
async function syncPersistent({settings=null,usage=capacity.usage,operationsConfig=null,send=sendDiscordMessage,edit=editDiscordMessage,remove=deleteDiscordMessage,inspect=inspectCanonical,findStatusMessages=findOwnedStatusMessages,transactionFn=transaction,now=new Date()}={}){
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
      stored={channelId,messageId:'',text:'',remaining:null,observedRemaining:null,lastAdvertSlot:null,lastVerifiedAt:null,updatedAt:null};
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
        lastAdvertSlot:currentSlot,
        lastVerifiedAt:now.toISOString()
      });
      return{processed:1,updated:1,created:1,availabilityRestored:0,remaining:actualRemaining,observedRemaining:actualRemaining,messageId};
    }

    // A missing canonical message can exist even when the stored count equals
    // the live count. The normal downward-only edit path cannot detect it.
    // Reuse and correct an existing bot-owned status card (including orphaned
    // green messages) rather than posting another duplicate. Do not notify
    // everyone. The advisory lock serializes this with reservations and digest.
    let verifiedNow=false;
    const lastVerified=Date.parse(stored.lastVerifiedAt||'');
    if(stored.messageId&&(!Number.isFinite(lastVerified)||now.getTime()-lastVerified>=CANONICAL_VERIFY_INTERVAL_MS)){
      let canonical=null;
      try{canonical=await inspect({channelId,messageId:stored.messageId});}
      catch(error){if(!discordMissing(error))throw error;}
      if(!canonical){
        const candidates=await findStatusMessages({channelId});
        const previousCount=stored.remaining==null?actualRemaining:Math.max(0,Math.floor(Number(stored.remaining)||0));
        const visibleCount=Math.min(actualRemaining,previousCount); // Never publish buffered increases early.
        const message=persistentMessage(visibleCount,publicBaseUrl);
        const chosen=candidates[0]||null;
        let sent;
        if(chosen){
          sent=await edit({channelId,messageId:chosen.id,text:persistentText(visibleCount,publicBaseUrl),message});
        }else{
          sent=await send({channelId,text:persistentText(visibleCount,publicBaseUrl),message,allowEveryone:false});
        }
        const messageId=String(sent?.id||'');
        if(!messageId)throw new Error('Discord did not confirm replacement availability message.');
        // Other bot-owned Free Server cards are obsolete. Never touch messages
        // from other authors or unrelated bot notifications.
        for(const old of candidates){
          if(String(old.id)===messageId)continue;
          try{await remove({channelId,messageId:old.id});}
          catch(error){if(!discordMissing(error))throw error;}
        }
        await saveState(db,{
          ...stored,channelId,messageId,text:JSON.stringify(message),
          remaining:visibleCount,observedRemaining:actualRemaining,
          lastAdvertSlot:stored.lastAdvertSlot||currentSlot,
          lastVerifiedAt:now.toISOString()
        });
        return{processed:1,updated:1,recoveredMissingCanonical:1,created:chosen?0:1,
          remaining:visibleCount,observedRemaining:actualRemaining,messageId};
      }
      const expectedRemaining=stored.remaining==null?actualRemaining:Math.max(0,Math.floor(Number(stored.remaining)||0));
      const visibleCount=Math.min(expectedRemaining,actualRemaining);
      const expected=persistentMessage(visibleCount,publicBaseUrl);
      const remoteEmbed=canonical?.embeds?.find(embed=>/Free Server availability/.test(String(embed.title||'')));
      // Compare the displayed count, not only the traffic-light title.
      const inconsistent=remoteEmbed?.title!==expected.embeds[0].title ||
        remoteEmbed?.description!==expected.embeds[0].description;
      if(inconsistent){
        const changed=await edit({channelId,messageId:stored.messageId,text:persistentText(visibleCount,publicBaseUrl),message:expected});
        if(String(changed?.id||'')!==stored.messageId)throw new Error('Discord did not confirm canonical availability edit.');
      }
      // Even a healthy canonical ID can coexist with abandoned green cards
      // after a previous failed deletion. Never leave two bot-owned statuses.
      const candidates=await findStatusMessages({channelId});
      for(const old of candidates){
        if(String(old.id)===stored.messageId)continue;
        try{await remove({channelId,messageId:old.id});}
        catch(error){if(!discordMissing(error))throw error;}
      }
      stored.lastVerifiedAt=now.toISOString();
      verifiedNow=true;
      if(inconsistent||candidates.some(old=>String(old.id)!==stored.messageId)){
        await saveState(db,{
          ...stored,text:JSON.stringify(expected),
          remaining:visibleCount,observedRemaining:actualRemaining,
          lastVerifiedAt:now.toISOString()
        });
        return{processed:1,updated:1,repairedCanonicalContent:inconsistent?1:0,removedDuplicates:candidates.filter(old=>String(old.id)!==stored.messageId).length,remaining:visibleCount,messageId:stored.messageId};
      }
    }

    // Existing installations predate scheduled batching. Establish the current
    // slot as a baseline without generating a surprise fresh notification at
    // deploy time.
    if(!stored.lastAdvertSlot){
      stored.lastAdvertSlot=currentSlot;
    }

    if(stored.remaining==null){
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
        lastAdvertSlot:stored.lastAdvertSlot
      });
      return{processed:1,updated:1,created:created?1:0,availabilityRestored:0,remaining:actualRemaining,observedRemaining:actualRemaining,messageId,legacyBaseline:true};
    }

    const displayedRemaining=Math.max(0,Math.floor(Number(stored.remaining)||0));
    const slotAdvanced=Boolean(currentSlot&&stored.lastAdvertSlot!==currentSlot);
    const increaseBuffered=actualRemaining>displayedRemaining;
    const publishIncrease=Boolean(slotAdvanced&&increaseBuffered&&actualRemaining>=minRemaining);

    if(publishIncrease){
      try{await remove({channelId,messageId:stored.messageId});}
      catch(error){
        if(!discordMissing(error))throw error; // Do not publish a competing green card while the old status remains.
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

    const stateChanged=stored.observedRemaining!==actualRemaining||slotAdvanced||verifiedNow;
    if(stateChanged){
      await saveState(db,{
        channelId,
        messageId:stored.messageId,
        text:stored.text,
        remaining:displayedRemaining,
        observedRemaining:actualRemaining,
        lastAdvertSlot:slotAdvanced?currentSlot:stored.lastAdvertSlot,
        lastVerifiedAt:stored.lastVerifiedAt
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

module.exports={STATE_KEY,CANONICAL_VERIFY_INTERVAL_MS,run,syncPersistent,localStamp,dueSlot,advertSlotKey,freePlan,freeRegistrationUrl,persistentText,persistentMessage,signupExplanation,loadState,saveState,inspectCanonical,findOwnedStatusMessages,editDiscordMessage,deleteDiscordMessage,sendDiscordMessage,discordMissing,becameAvailable};