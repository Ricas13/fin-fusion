'use strict';
const {query}=require('../db');
const emailSettings=require('./email-settings');
const emailOutbox=require('./email-outbox');
const notificationOutbox=require('./notification-outbox');
const notificationSettings=require('./notification-settings');
const runtimeSettings=require('../platform/runtime-settings');
function trim(v,n=4000){return String(v||'').trim().slice(0,n)}
async function preference(eventType){const result=await query(`SELECT telegram_enabled,email_enabled FROM notification_preferences WHERE event_type=$1`,[eventType]);return result.rows[0]||{telegram_enabled:false,email_enabled:false}}
async function telegram(text){const status=await notificationSettings.status();if(!status.telegramConfigured)return{queued:false,reason:'not_configured'};return notificationOutbox.enqueueTelegram({eventType:'manual.telegram',text:trim(text,3500),dedupeKey:null})}
async function dispatch({eventType,to=null,subject,text,html=null,dedupeKey=null}){const pref=await preference(eventType),result={eventType,email:false,telegram:false,errors:[]};if(pref.email_enabled&&to){try{const status=await emailSettings.status();if(status.configured){await emailOutbox.enqueue({type:eventType,to,subject:trim(subject,300),text:trim(text,12000),html:html||null,dedupeKey:dedupeKey||null});result.email=true}}catch(error){result.errors.push(`email: ${error.message}`)}}if(pref.telegram_enabled){try{const queued=await notificationOutbox.enqueueTelegram({eventType,text:`${trim(subject,300)}\n${trim(text,3200)}`,dedupeKey:dedupeKey?`telegram:${dedupeKey}`:null});result.telegram=Boolean(queued.queued)}catch(error){result.errors.push(`telegram: ${error.message}`)}}return result}
async function resellerEvent(resellerId,eventType,{title,detail,dedupeKey=null}={}){await runtimeSettings.ensureLoaded().catch(()=>{});const found=await query(`SELECT u.email,u.username FROM resellers r JOIN app_users u ON u.id=r.user_id WHERE r.id=$1`,[resellerId]);if(!found.rowCount)return{skipped:'reseller_not_found'};const row=found.rows[0],site=runtimeSettings.siteName(),subject=title||`${site} reseller update`,text=`${row.username||'Reseller'}: ${detail||eventType}`;return dispatch({eventType,to:row.email||null,subject,text,dedupeKey:dedupeKey||`${eventType}:${resellerId}:${Date.now()}`})}
module.exports={dispatch,resellerEvent,preference,telegram};
