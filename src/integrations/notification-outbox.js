'use strict';

const { query, transaction } = require('../db');
const {encryptWithEnv,decryptWithEnv}=require('../security/purpose-crypto');
const settings = require('./notification-settings');
const discordMessage = require('./discord-message');
const telegramMessage = require('./telegram-message');
const freshness = require('./integrity-alert-freshness');
const PREFIX='notify1',KEY_ENV='DATA_ENCRYPTION_KEY',STALE_SENDING_MINUTES=15;
const UNCERTAIN_DELIVERY_ERROR='Delivery outcome is uncertain after a worker interruption or post-send database failure. Automatic resend is blocked to prevent duplicate customer/admin messages; review and retry manually if required.';
function clean(v,n=12000){return String(v||'').trim().slice(0,n)}
function encryptPayload(payload){return encryptWithEnv(JSON.stringify(payload),KEY_ENV,PREFIX)}
function decryptPayload(value){return value?JSON.parse(decryptWithEnv(value,KEY_ENV,PREFIX)):null}
function structuredPayload(message){
    if(!message||typeof message!=='object'||Array.isArray(message))return null;
    try{
        const encoded=JSON.stringify(message);
        if(encoded.length>12000)return null;
        return JSON.parse(encoded);
    }catch{return null}
}

async function sendDiscordStructured({destination,text,message,discordChannel=false,allowEveryone=false}){
    const fallbackText=clean(text,1900);
    if(!message){
        if(discordChannel)return settings.sendDiscordChannel({channelId:destination,text:fallbackText,allowEveryone});
        return settings.sendDiscord(fallbackText,{userId:destination});
    }
    if(discordChannel){
        return settings.discordApi(`/channels/${encodeURIComponent(destination)}/messages`,{method:'POST',body:discordMessage.body(message,{fallbackText,allowEveryone})});
    }
    const channel=await settings.discordApi('/users/@me/channels',{method:'POST',body:{recipient_id:destination}});
    if(!channel.id)throw new Error('Discord did not return a DM channel.');
    return settings.discordApi(`/channels/${encodeURIComponent(channel.id)}/messages`,{method:'POST',body:discordMessage.body(message,{fallbackText,allowEveryone:false})});
}

async function enqueue(channel,{eventType,text,message=null,dedupeKey=null,destination=null,discordChannel=false,allowEveryone=false}){
    const cfg=await settings.status();
    const configured=channel==='telegram'?cfg.telegramConfigured:channel==='discord'?cfg.discordConfigured:false;
    if(!configured)return{queued:false,reason:`${channel}_not_configured`};
    const defaultDestination=channel==='telegram'?cfg.telegramAdminChatId:channel==='discord'?cfg.discordAdminUserId:null;
    const target=clean(destination||defaultDestination,120);
    if(!target)return{queued:false,reason:`${channel}_destination_required`};
    const structured=['discord','telegram'].includes(channel)?structuredPayload(message):null;
    const payload={text:clean(text,channel==='discord'?1900:4000),...(structured?{message:structured}:{}),...(channel==='discord'&&discordChannel?{discordChannel:true,allowEveryone:Boolean(allowEveryone)}:{})};
    const key=dedupeKey?clean(dedupeKey,500):null;
    const nextAttemptAt=freshness.nextAttemptAt(key);
    const result=await query(`INSERT INTO notification_outbox(channel,message_type,event_type,destination,payload,payload_encrypted,dedupe_key,status,next_attempt_at) VALUES($1,$2,$2,$3,'{}'::jsonb,$4,$5,'pending',$6) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,[channel,clean(eventType,200),target,encryptPayload(payload),key,nextAttemptAt]);
    return{queued:Boolean(result.rowCount),id:result.rows[0]?.id||null};
}
async function enqueueTelegram(input){return enqueue('telegram',input)}
async function enqueueDiscord(input){return enqueue('discord',input)}
async function enqueueDiscordChannel(input){return enqueue('discord',{...input,discordChannel:true})}
async function quarantineStaleSending(){const r=await query(`UPDATE notification_outbox SET status='dead',last_error=$1,next_attempt_at=NOW(),updated_at=NOW() WHERE channel<>'email' AND status='sending' AND last_attempt_at<=NOW()-make_interval(mins=>$2) RETURNING id`,[UNCERTAIN_DELIVERY_ERROR,STALE_SENDING_MINUTES]);return r.rowCount}
async function claim(limit=25){return transaction(async client=>{const rows=await client.query(`SELECT id,channel,message_type,event_type,destination,payload,payload_encrypted,dedupe_key,attempts FROM notification_outbox WHERE channel<>'email' AND status IN('pending','failed') AND next_attempt_at<=NOW() ORDER BY next_attempt_at,created_at LIMIT $1 FOR UPDATE SKIP LOCKED`,[Math.max(1,Math.min(100,Number(limit)||25))]);if(!rows.rowCount)return[];await client.query(`UPDATE notification_outbox SET status='sending',last_attempt_at=NOW(),attempts=attempts+1,updated_at=NOW() WHERE id=ANY($1::uuid[])`,[rows.rows.map(r=>r.id)]);return rows.rows})}
function retryAt(attempt){const seconds=Math.min(3600,Math.max(30,30*Math.pow(2,Math.max(0,Number(attempt||1)-1))));return new Date(Date.now()+seconds*1000)}
async function delivered(id){await query(`UPDATE notification_outbox SET status='sent',sent_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id=$1 AND status='sending'`,[id])}
async function failed(row,error){const attempts=Number(row.attempts||0)+1,dead=attempts>=8;await query(`UPDATE notification_outbox SET status=$2,next_attempt_at=$3,last_error=$4,updated_at=NOW() WHERE id=$1`,[row.id,dead?'dead':'failed',dead?new Date():retryAt(attempts),clean(error?.message||error,1000)])}
async function uncertain(row,error){try{await query(`UPDATE notification_outbox SET status='dead',next_attempt_at=NOW(),last_error=$2,updated_at=NOW() WHERE id=$1 AND status='sending'`,[row.id,`${UNCERTAIN_DELIVERY_ERROR} Persistence error: ${clean(error?.message||error,700)}`.slice(0,1500)])}catch(writeError){console.error('Unable to quarantine uncertain notification delivery.',{id:row.id,error:clean(writeError?.message||writeError,700)})}return{uncertain:true}}
async function deliverDue({limit=25}={}){
    const quarantined=await quarantineStaleSending();
    const rows=await claim(limit);
    let sent=0,failedCount=quarantined,suppressed=0;
    for(const row of rows){
        try{
            const gate=await freshness.cancelIfStale(row);
            if(gate.cancelled){suppressed++;continue}
        }catch(error){
            await failed(row,error);
            failedCount++;
            continue;
        }
        let payload;
        try{
            payload=row.payload_encrypted?decryptPayload(row.payload_encrypted):row.payload||{};
            if(row.channel==='telegram'&&payload?.message)await telegramMessage.send(settings,{chatId:row.destination,message:payload.message,fallbackText:payload?.text||row.message_type});
            else if(row.channel==='telegram')await settings.sendTelegram(payload?.text||row.message_type,{chatId:row.destination});
            else if(row.channel==='discord'&&!payload?.message&&payload?.discordChannel)await settings.sendDiscordChannel({channelId:row.destination,text:payload?.text||row.message_type,allowEveryone:Boolean(payload?.allowEveryone)});
            else if(row.channel==='discord'&&!payload?.message)await settings.sendDiscord(payload?.text||row.message_type,{userId:row.destination});
            else if(row.channel==='discord')await sendDiscordStructured({destination:row.destination,text:payload?.text||row.message_type,message:payload.message,discordChannel:Boolean(payload?.discordChannel),allowEveryone:Boolean(payload?.allowEveryone)});
            else throw new Error(`Unsupported notification channel ${row.channel}`);
        }catch(error){
            await failed(row,error);
            failedCount++;
            continue;
        }
        try{await delivered(row.id);sent++}catch(error){await uncertain(row,error);failedCount++}
    }
    const result={processed:rows.length+quarantined,sent,failed:failedCount,quarantined,suppressed};
    if(quarantined)result.warning=`${quarantined} notification deliver${quarantined===1?'y':'ies'} had an uncertain outcome after a worker interruption and were quarantined instead of resent.`;
    return result;
}
async function recent(limit=100){const r=await query(`SELECT id,channel,message_type,event_type,destination,status,attempts,last_attempt_at,sent_at,last_error,created_at FROM notification_outbox WHERE channel<>'email' ORDER BY created_at DESC LIMIT $1`,[Math.max(1,Math.min(500,Number(limit)||100))]);return r.rows}
async function retry(id){const r=await query(`UPDATE notification_outbox SET status='pending',next_attempt_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id=$1 AND channel<>'email' AND status IN('failed','dead','sending') RETURNING id`,[id]);return Boolean(r.rowCount)}
module.exports={enqueueTelegram,enqueueDiscord,enqueueDiscordChannel,deliverDue,recent,retry,claim,quarantineStaleSending,encryptPayload,decryptPayload,structuredPayload,sendDiscordStructured,STALE_SENDING_MINUTES,UNCERTAIN_DELIVERY_ERROR};
