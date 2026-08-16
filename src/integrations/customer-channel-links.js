'use strict';

const crypto=require('crypto');
const {query,transaction}=require('../db');

function hash(raw){return crypto.createHash('sha256').update(String(raw||''),'utf8').digest('hex')}
function cleanChannel(value){const v=String(value||'').toLowerCase();if(!['telegram','discord'].includes(v))throw new Error('Unsupported communication channel');return v}
async function issue(customerId,channel,{ttlMinutes=15}={}){
  channel=cleanChannel(channel);
  const token=crypto.randomBytes(24).toString('base64url'),tokenHash=hash(token),expires=new Date(Date.now()+Math.max(5,Math.min(60,Number(ttlMinutes)||15))*60000);
  await transaction(async client=>{
    await client.query(`DELETE FROM customer_channel_link_tokens WHERE customer_id=$1 AND channel=$2 AND used_at IS NULL`,[customerId,channel]);
    await client.query(`INSERT INTO customer_channel_link_tokens(customer_id,channel,token_hash,expires_at) VALUES($1,$2,$3,$4)`,[customerId,channel,tokenHash,expires]);
  });
  return{token,expiresAt:expires};
}
async function consume(raw,channel,linker){
  channel=cleanChannel(channel);const tokenHash=hash(raw);
  return transaction(async client=>{
    const found=await client.query(`SELECT * FROM customer_channel_link_tokens WHERE channel=$1 AND token_hash=$2 AND used_at IS NULL AND expires_at>NOW() FOR UPDATE`,[channel,tokenHash]);
    if(!found.rowCount)return null;
    const row=found.rows[0];
    await linker(client,row.customer_id);
    await client.query(`UPDATE customer_channel_link_tokens SET used_at=NOW() WHERE id=$1`,[row.id]);
    return{customerId:row.customer_id};
  });
}
async function linkTelegram(raw,{chatId,username=null}){
  const id=String(chatId||'').trim();if(!/^-?\d{1,30}$/.test(id))throw new Error('Telegram chat identity is invalid');
  return consume(raw,'telegram',async(client,customerId)=>{
    await client.query(`INSERT INTO customer_communication_preferences(customer_id,telegram_chat_id,telegram_handle,telegram_opt_in,telegram_linked_at) VALUES($1,$2,$3,TRUE,NOW()) ON CONFLICT(customer_id) DO UPDATE SET telegram_chat_id=EXCLUDED.telegram_chat_id,telegram_handle=COALESCE(EXCLUDED.telegram_handle,customer_communication_preferences.telegram_handle),telegram_opt_in=TRUE,telegram_linked_at=NOW(),updated_at=NOW()`,[customerId,id,username?String(username).replace(/^@/,'').slice(0,64):null]);
  });
}
async function linkDiscord(raw,{userId,handle=null}){
  const id=String(userId||'').trim();if(!/^\d{15,24}$/.test(id))throw new Error('Discord user identity is invalid');
  return consume(raw,'discord',async(client,customerId)=>{
    await client.query(`INSERT INTO customer_communication_preferences(customer_id,discord_user_id,discord_handle,discord_opt_in,discord_linked_at) VALUES($1,$2,$3,TRUE,NOW()) ON CONFLICT(customer_id) DO UPDATE SET discord_user_id=EXCLUDED.discord_user_id,discord_handle=COALESCE(EXCLUDED.discord_handle,customer_communication_preferences.discord_handle),discord_opt_in=TRUE,discord_linked_at=NOW(),updated_at=NOW()`,[customerId,id,handle?String(handle).slice(0,100):null]);
  });
}
async function unlink(customerId,channel){
  channel=cleanChannel(channel);
  if(channel==='telegram')await query(`UPDATE customer_communication_preferences SET telegram_chat_id=NULL,telegram_linked_at=NULL,telegram_opt_in=FALSE,updated_at=NOW() WHERE customer_id=$1`,[customerId]);
  else await query(`UPDATE customer_communication_preferences SET discord_user_id=NULL,discord_linked_at=NULL,discord_opt_in=FALSE,updated_at=NOW() WHERE customer_id=$1`,[customerId]);
}
module.exports={issue,consume,linkTelegram,linkDiscord,unlink,hash};
