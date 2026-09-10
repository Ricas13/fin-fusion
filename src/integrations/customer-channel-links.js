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
async function inspect(raw,channel){
  channel=cleanChannel(channel);const tokenHash=hash(raw),found=await query(`SELECT customer_id,expires_at FROM customer_channel_link_tokens WHERE channel=$1 AND token_hash=$2 AND used_at IS NULL AND expires_at>NOW() LIMIT 1`,[channel,tokenHash]);
  if(!found.rowCount)return null;
  return{customerId:found.rows[0].customer_id,expiresAt:found.rows[0].expires_at};
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
async function linkDiscord(raw,{userId,handle=null},{inspectFn=inspect,consumeFn=consume,withCustomerLock=null,syncRolesFn=null}={}){
  const id=String(userId||'').trim();if(!/^\d{15,24}$/.test(id))throw new Error('Discord user identity is invalid');
  const linkedHandle=handle?String(handle).slice(0,100):null;
  const pending=await inspectFn(raw,'discord');
  if(!pending)return null;
  const runLocked=withCustomerLock||require('../jellyfin/reconciliation-lock').withCustomerReconciliationLock;
  const syncRoles=syncRolesFn||require('./discord-roles').syncRoleForCustomer;
  return runLocked(pending.customerId,async()=>consumeFn(raw,'discord',async(client,customerId)=>{
    if(String(customerId)!==String(pending.customerId))throw new Error('Discord link token customer changed during consumption');
    const current=await client.query(`SELECT discord_user_id FROM customer_communication_preferences WHERE customer_id=$1 FOR UPDATE`,[customerId]);
    const previousId=String(current.rows[0]?.discord_user_id||'').trim();
    if(previousId&&previousId!==id){
      // Keep the old identity authoritative until every CAPTAiNFiN-managed role
      // has been revoked. Holding the customer reconciliation lock prevents a
      // concurrent entitlement sweep from re-adding those roles mid-relink.
      const revoked=await syncRoles(customerId,[]);
      const failures=[...(revoked?.errors||[]),...(revoked?.configurationErrors||[])].filter(Boolean);
      if(revoked?.skipped==='not_configured')failures.push('Discord role management is not configured');
      if(failures.length){
        const error=new Error(`Discord roles could not be removed from the previous account before relink: ${failures.join('; ').slice(0,800)}`);
        error.code='DISCORD_RELINK_ROLE_REVOKE_FAILED';
        throw error;
      }
    }
    await client.query(`INSERT INTO customer_communication_preferences(customer_id,discord_user_id,discord_handle,discord_opt_in,discord_linked_at) VALUES($1,$2,$3,TRUE,NOW()) ON CONFLICT(customer_id) DO UPDATE SET discord_user_id=EXCLUDED.discord_user_id,discord_handle=COALESCE(EXCLUDED.discord_handle,customer_communication_preferences.discord_handle),discord_opt_in=TRUE,discord_linked_at=NOW(),updated_at=NOW()`,[customerId,id,linkedHandle]);
    // Keep the old customer columns as a compatibility mirror only. OAuth is
    // authoritative and all new code reads customer_communication_preferences.
    await client.query(`UPDATE customers SET discord_user_id=$2,discord_username=$3,updated_at=NOW() WHERE id=$1`,[customerId,id,linkedHandle]);
    if(previousId&&previousId!==id){
      await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('customer.discord.relink','customer',$1,$2::jsonb)`,[customerId,JSON.stringify({managedRolesRevokedBeforeIdentityChange:true,previousDiscordUserId:previousId})]);
    }
  }));
}
async function revokeDiscordRolesBeforeUnlink(customerId,{alreadyLocked=false,syncRolesFn=null}={}){
  const lock=require('../jellyfin/reconciliation-lock');
  const syncRoles=syncRolesFn||require('./discord-roles').syncRoleForCustomer;
  const perform=async()=>{
    const linked=await query(`SELECT discord_user_id FROM customer_communication_preferences WHERE customer_id=$1 AND discord_user_id IS NOT NULL AND discord_user_id<>'' LIMIT 1`,[customerId]);
    if(!linked.rowCount)return{skipped:'not_linked',previousDiscordUserId:null};
    const previousDiscordUserId=String(linked.rows[0].discord_user_id);
    // activePlanIds=[] deliberately means "remove every role CAPTAiNFiN has ever
    // managed for this member". The Discord identity remains authoritative until
    // both this revoke and the following DB clear have completed under one lock.
    const result=await syncRoles(customerId,[]);
    const failures=[...(result?.errors||[]),...(result?.configurationErrors||[])].filter(Boolean);
    if(result?.skipped==='not_configured')failures.push('Discord role management is not configured');
    if(failures.length){
      const error=new Error(`Discord roles could not be removed before unlink: ${failures.join('; ').slice(0,800)}`);
      error.code='DISCORD_UNLINK_ROLE_REVOKE_FAILED';
      throw error;
    }
    return{...result,previousDiscordUserId};
  };
  return alreadyLocked?perform():lock.withCustomerReconciliationLock(customerId,perform);
}
async function unlink(customerId,channel,{withCustomerLock=null,syncRolesFn=null}={}){
  channel=cleanChannel(channel);
  if(channel==='telegram'){
    await query(`UPDATE customer_communication_preferences SET telegram_chat_id=NULL,telegram_linked_at=NULL,telegram_opt_in=FALSE,updated_at=NOW() WHERE customer_id=$1`,[customerId]);
    return;
  }
  const runLocked=withCustomerLock||require('../jellyfin/reconciliation-lock').withCustomerReconciliationLock;
  await runLocked(customerId,async()=>{
    const revoked=await revokeDiscordRolesBeforeUnlink(customerId,{alreadyLocked:true,syncRolesFn});
    await transaction(async client=>{
      await client.query(`UPDATE customer_communication_preferences SET discord_user_id=NULL,discord_handle=NULL,discord_linked_at=NULL,discord_opt_in=FALSE,updated_at=NOW() WHERE customer_id=$1`,[customerId]);
      await client.query(`UPDATE customers SET discord_user_id=NULL,discord_username=NULL,updated_at=NOW() WHERE id=$1`,[customerId]);
      await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('customer.discord.unlink','customer',$1,$2::jsonb)`,[customerId,JSON.stringify({managedRolesRevokedBeforeIdentityRemoval:true,previousDiscordUserId:revoked?.previousDiscordUserId||null})]);
    });
  });
}
module.exports={issue,inspect,consume,linkTelegram,linkDiscord,unlink,hash,revokeDiscordRolesBeforeUnlink};
