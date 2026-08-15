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
async function preference(eventType){const result=await query(`SELECT telegram_enabled,email_enabled FROM notification_preferences WHERE event_type=$1`,[eventType]);return result.rows[0]||{telegram_enabled:false,email_enabled:false}}
async function cooldownKey({eventType,to,subject,dedupeKey}){if(dedupeKey)return String(dedupeKey).slice(0,500);const cfg=await operations.get().catch(()=>operations.DEFAULTS),minutes=Math.max(0,Number(cfg.notificationCooldownMinutes||0));if(!minutes)return null;const bucket=Math.floor(Date.now()/(minutes*60000)),fingerprint=crypto.createHash('sha256').update(`${eventType}|${to||''}|${subject||''}`).digest('hex').slice(0,24);return `cooldown:${fingerprint}:${bucket}`}
async function telegram(text){const status=await notificationSettings.status();if(!status.telegramConfigured)return{queued:false,reason:'not_configured'};return notificationOutbox.enqueueTelegram({eventType:'manual.telegram',text:trim(text,3500),dedupeKey:null})}
async function dispatch({eventType,to=null,subject,text,html=null,dedupeKey=null}){const[pref,key]=await Promise.all([preference(eventType),cooldownKey({eventType,to,subject,dedupeKey})]),result={eventType,email:false,telegram:false,errors:[],dedupeKey:key};if(pref.email_enabled&&to){try{const status=await emailSettings.status();if(status.configured){const queued=await emailOutbox.enqueue({type:eventType,to,subject:trim(subject,300),text:trim(text,12000),html:html||null,dedupeKey:key});result.email=queued!==false}}catch(error){result.errors.push(`email: ${error.message}`)}}if(pref.telegram_enabled){try{const queued=await notificationOutbox.enqueueTelegram({eventType,text:`${trim(subject,300)}\n${trim(text,3200)}`,dedupeKey:key?`telegram:${key}`:null});result.telegram=Boolean(queued.queued)}catch(error){result.errors.push(`telegram: ${error.message}`)}}return result}
async function resellerEvent(resellerId,eventType,{title,detail,dedupeKey=null}={}){await runtimeSettings.ensureLoaded().catch(()=>{});const found=await query(`SELECT u.email,u.username FROM resellers r JOIN app_users u ON u.id=r.user_id WHERE r.id=$1`,[resellerId]);if(!found.rowCount)return{skipped:'reseller_not_found'};const row=found.rows[0],site=runtimeSettings.siteName(),subject=title||`${site} reseller update`,text=`${row.username||'Reseller'}: ${detail||eventType}`;return dispatch({eventType,to:row.email||null,subject,text,dedupeKey})}
module.exports={dispatch,resellerEvent,preference,telegram,cooldownKey};
