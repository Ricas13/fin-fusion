'use strict';

const { query, transaction } = require('../db');
const {encryptWithEnv,decryptWithEnv}=require('../security/purpose-crypto');
const settings = require('./notification-settings');
const PREFIX='notify1',KEY_ENV='DATA_ENCRYPTION_KEY';
function clean(v,n=12000){return String(v||'').trim().slice(0,n)}
function encryptPayload(payload){return encryptWithEnv(JSON.stringify(payload),KEY_ENV,PREFIX)}
function decryptPayload(value){return value?JSON.parse(decryptWithEnv(value,KEY_ENV,PREFIX)):null}
async function enqueueTelegram({eventType,text,dedupeKey=null,destination=null}){
    const cfg=await settings.status();
    if(!cfg.telegramConfigured)return{queued:false,reason:'telegram_not_configured'};
    const result=await query(`
        INSERT INTO notification_outbox(channel,message_type,event_type,destination,payload,payload_encrypted,dedupe_key,status,next_attempt_at)
        VALUES('telegram',$1,$1,$2,'{}'::jsonb,$3,$4,'pending',NOW())
        ON CONFLICT(dedupe_key) DO NOTHING RETURNING id
    `,[clean(eventType,200),destination||cfg.telegramChatId,encryptPayload({text:clean(text,3500)}),dedupeKey||null]);
    return{queued:Boolean(result.rowCount),id:result.rows[0]?.id||null};
}
async function claim(limit=25){return transaction(async client=>{const rows=await client.query(`
        SELECT id,channel,message_type,event_type,destination,payload,payload_encrypted,attempts
        FROM notification_outbox
        WHERE channel<>'email' AND status IN('pending','failed') AND next_attempt_at<=NOW()
        ORDER BY next_attempt_at,created_at
        LIMIT $1 FOR UPDATE SKIP LOCKED
    `,[Math.max(1,Math.min(100,Number(limit)||25))]);if(!rows.rowCount)return[];await client.query(`UPDATE notification_outbox SET status='sending',last_attempt_at=NOW(),attempts=attempts+1,updated_at=NOW() WHERE id=ANY($1::uuid[])`,[rows.rows.map(r=>r.id)]);return rows.rows})}
function retryAt(attempt){const seconds=Math.min(3600,Math.max(30,30*Math.pow(2,Math.max(0,Number(attempt||1)-1))));return new Date(Date.now()+seconds*1000)}
async function delivered(id){await query(`UPDATE notification_outbox SET status='sent',sent_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id=$1`,[id])}
async function failed(row,error){const attempts=Number(row.attempts||0)+1,dead=attempts>=8;await query(`UPDATE notification_outbox SET status=$2,next_attempt_at=$3,last_error=$4,updated_at=NOW() WHERE id=$1`,[row.id,dead?'dead':'failed',dead?new Date():retryAt(attempts),clean(error?.message||error,1000)])}
async function deliverDue({limit=25}={}){const rows=await claim(limit);let sent=0,failedCount=0;for(const row of rows){try{if(row.channel==='telegram'){const payload=row.payload_encrypted?decryptPayload(row.payload_encrypted):row.payload||{};await settings.sendTelegram(payload?.text||row.message_type,{chatId:row.destination||null});}else throw new Error(`Unsupported notification channel ${row.channel}`);await delivered(row.id);sent++}catch(error){await failed(row,error);failedCount++}}return{processed:rows.length,sent,failed:failedCount}}
async function recent(limit=100){const r=await query(`SELECT id,channel,message_type,event_type,destination,status,attempts,last_attempt_at,sent_at,last_error,created_at FROM notification_outbox WHERE channel<>'email' ORDER BY created_at DESC LIMIT $1`,[Math.max(1,Math.min(500,Number(limit)||100))]);return r.rows}
async function retry(id){const r=await query(`UPDATE notification_outbox SET status='pending',next_attempt_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id=$1 AND channel<>'email' AND status IN('failed','dead') RETURNING id`,[id]);return Boolean(r.rowCount)}
module.exports={enqueueTelegram,deliverDue,recent,retry,claim,encryptPayload,decryptPayload};
