'use strict';
const crypto=require('crypto');
const {query}=require('../db');
const emailSettings=require('./email-settings');
const emailOutbox=require('./email-outbox');
const notificationOutbox=require('./notification-outbox');
const notificationSettings=require('./notification-settings');
const runtimeSettings=require('../platform/runtime-settings');
const operations=require('../platform/operations-settings');
function trim(v,n=4000){return String(v||'').trim().slice(0,n)}
const MANDATORY_EMAIL_EVENTS=new Set(['customer.registered','customer.subscription.requested','customer.trial.requested','customer.stremio.requested','customer.reseller.requested','customer.service.provisioned','payment.failed','payment.received','subscription.activated','subscription.expiring']);
async function preference(eventType){const result=await query(`SELECT telegram_enabled,email_enabled,discord_enabled,whatsapp_enabled FROM notification_preferences WHERE event_type=$1`,[eventType]);return result.rows[0]||{telegram_enabled:false,email_enabled:false,discord_enabled:false,whatsapp_enabled:false}}
async function cooldownKey({eventType,to,subject,dedupeKey}){if(dedupeKey)return String(dedupeKey).slice(0,500);const cfg=await operations.get().catch(()=>operations.DEFAULTS),minutes=Math.max(0,Number(cfg.notificationCooldownMinutes||0));if(!minutes)return null;const bucket=Math.floor(Date.now()/(minutes*60000)),fingerprint=crypto.createHash('sha256').update(`${eventType}|${to||''}|${subject||''}`).digest('hex').slice(0,24);return `cooldown:${fingerprint}:${bucket}`}
async function telegram(text){const status=await notificationSettings.status();if(!status.telegramConfigured||!status.telegramAdminChatId)return{queued:false,reason:'not_configured'};return notificationOutbox.enqueueTelegram({eventType:'manual.telegram',text:trim(text,3500),destination:status.telegramAdminChatId,dedupeKey:null})}
async function customerChannels({customerId=null,email=null}={}){
 const args=[],where=[];if(customerId){args.push(customerId);where.push(`c.id=$${args.length}`)}if(email){args.push(String(email).trim().toLowerCase());where.push(`LOWER(COALESCE(u.email,c.email,''))=$${args.length}`)}if(!where.length)return null;
 const result=await query(`SELECT c.id customer_id,cp.phone_e164,cp.whatsapp_opt_in,cp.telegram_chat_id,cp.telegram_opt_in,cp.discord_user_id,cp.discord_opt_in FROM customers c JOIN app_users u ON u.id=c.user_id LEFT JOIN customer_communication_preferences cp ON cp.customer_id=c.id WHERE ${where.join(' OR ')} LIMIT 1`,args);
 return result.rows[0]||null;
}
async function dispatch({eventType,to=null,customerId=null,subject,text,html=null,dedupeKey=null,whatsappTo=null,forceEmail=false}){
 const[pref,key,delivery,customer]=await Promise.all([preference(eventType),cooldownKey({eventType,to,subject,dedupeKey}),notificationSettings.status().catch(()=>({})),customerChannels({customerId,email:to}).catch(()=>null)]),result={eventType,email:false,telegram:false,discord:false,whatsapp:false,errors:[],dedupeKey:key},combined=`${trim(subject,300)}\n${trim(text,3200)}`,customerTarget=Boolean(customer);
 if((forceEmail||pref.email_enabled||MANDATORY_EMAIL_EVENTS.has(eventType))&&to){try{const status=await emailSettings.status();if(status.configured){const queued=await emailOutbox.enqueue({type:eventType,to,subject:trim(subject,300),text:trim(text,12000),html:html||null,dedupeKey:key});result.email=queued!==false}}catch(error){result.errors.push(`email: ${error.message}`)}}
 if(pref.telegram_enabled){try{const destination=customerTarget?(customer.telegram_opt_in?customer.telegram_chat_id:null):delivery.telegramAdminChatId;if(destination){const queued=await notificationOutbox.enqueueTelegram({eventType,text:combined,destination,dedupeKey:key?`telegram:${key}`:null});result.telegram=Boolean(queued.queued)}}catch(error){result.errors.push(`telegram: ${error.message}`)}}
 if(pref.discord_enabled){try{const destination=customerTarget?(customer.discord_opt_in?customer.discord_user_id:null):delivery.discordAdminUserId;if(destination){const queued=await notificationOutbox.enqueueDiscord({eventType,text:combined,destination,dedupeKey:key?`discord:${key}`:null});result.discord=Boolean(queued.queued)}}catch(error){result.errors.push(`discord: ${error.message}`)}}
 if(pref.whatsapp_enabled){try{const destination=whatsappTo||(customerTarget&&customer.whatsapp_opt_in?customer.phone_e164:null);if(destination){const queued=await notificationOutbox.enqueueWhatsapp({eventType,text:combined,destination,dedupeKey:key?`whatsapp:${key}:${String(destination).slice(-8)}`:null});result.whatsapp=Boolean(queued.queued)}}catch(error){result.errors.push(`whatsapp: ${error.message}`)}}
 return result;
}
async function resellerEvent(resellerId,eventType,{title,detail,dedupeKey=null}={}){await runtimeSettings.ensureLoaded().catch(()=>{});const found=await query(`SELECT u.email,u.username,c.id customer_id FROM resellers r JOIN app_users u ON u.id=r.user_id LEFT JOIN customers c ON c.user_id=u.id WHERE r.id=$1`,[resellerId]);if(!found.rowCount)return{skipped:'reseller_not_found'};const row=found.rows[0],site=runtimeSettings.siteName(),subject=title||`${site} reseller update`,text=`${row.username||'Reseller'}: ${detail||eventType}`;return dispatch({eventType,to:row.email||null,customerId:row.customer_id||null,subject,text,dedupeKey})}
module.exports={dispatch,resellerEvent,preference,telegram,cooldownKey,MANDATORY_EMAIL_EVENTS,customerChannels};
