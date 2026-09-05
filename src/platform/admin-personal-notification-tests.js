'use strict';

const express=require('express');
const csrf=require('../auth/csrf');
const {query}=require('../db');
const runtimeSettings=require('./runtime-settings');
const emailSettings=require('../integrations/email-settings');
const notificationSettings=require('../integrations/notification-settings');

function gate(req,res,next){
  if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();
  return res.redirect('/login?session=expired');
}
function noStore(_req,res,next){
  res.setHeader('Cache-Control','no-store, private, max-age=0');
  res.setHeader('Pragma','no-cache');
  next();
}
function redirect(res,type,text){
  return res.redirect(`/admin/profile/notifications?${type}=${encodeURIComponent(text)}`);
}
async function identity(adminUserId){
  const r=await query(`SELECT u.email,c.telegram_chat_id,c.telegram_handle,c.discord_user_id,c.discord_handle
    FROM app_users u
    LEFT JOIN admin_communication_preferences c ON c.admin_user_id=u.id
    WHERE u.id=$1 AND u.role='admin'`,[adminUserId]);
  if(!r.rowCount)throw new Error('Administrator profile not found.');
  return r.rows[0];
}
async function audit(adminUserId,channel,ok,error=null){
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
    VALUES($1,'admin.notifications.personal.test','app_user',$1,$2::jsonb)`,[
      adminUserId,
      JSON.stringify({channel,ok,error:error?String(error).slice(0,300):null})
    ]).catch(()=>{});
}
function testText(site,channel){
  return `Test notification from ${site}. Your personal ${channel} notification delivery is working.`;
}

function createAdminPersonalNotificationTestsRouter(){
  const r=express.Router();
  r.use('/admin/profile/notifications/test',gate,noStore);

  r.post('/admin/profile/notifications/test/email',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid security token');
    try{
      const me=await identity(req.session.authUserId);
      if(!me.email)throw new Error('Set your administrator email before testing email delivery.');
      const status=await emailSettings.status();
      if(!status.configured)throw new Error('Email infrastructure is not configured globally.');
      const site=runtimeSettings.siteName();
      await emailSettings.send({to:me.email,subject:`${site} personal notification test`,text:testText(site,'email')});
      await audit(req.session.authUserId,'email',true);
      return redirect(res,'message',`Test email sent to ${me.email}.`);
    }catch(error){await audit(req.session.authUserId,'email',false,error.message);return redirect(res,'error',`Email test failed: ${error.message}`);}
  });

  r.post('/admin/profile/notifications/test/telegram',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid security token');
    try{
      const me=await identity(req.session.authUserId);
      if(!me.telegram_chat_id)throw new Error('Connect your Telegram account first.');
      const status=await notificationSettings.status();
      if(!status.telegramConfigured)throw new Error('Telegram is not configured globally.');
      const site=runtimeSettings.siteName();
      await notificationSettings.sendTelegram(testText(site,'Telegram'),{chatId:me.telegram_chat_id});
      await audit(req.session.authUserId,'telegram',true);
      return redirect(res,'message',`Test Telegram message sent${me.telegram_handle?` to @${me.telegram_handle}`:''}.`);
    }catch(error){await audit(req.session.authUserId,'telegram',false,error.message);return redirect(res,'error',`Telegram test failed: ${error.message}`);}
  });

  r.post('/admin/profile/notifications/test/discord',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid security token');
    try{
      const me=await identity(req.session.authUserId);
      if(!me.discord_user_id)throw new Error('Connect your Discord account first.');
      const status=await notificationSettings.status();
      if(!status.discordConfigured)throw new Error('Discord is not configured globally.');
      const site=runtimeSettings.siteName();
      await notificationSettings.sendDiscord(testText(site,'Discord'),{userId:me.discord_user_id});
      await audit(req.session.authUserId,'discord',true);
      return redirect(res,'message',`Test Discord DM sent${me.discord_handle?` to ${me.discord_handle}`:''}.`);
    }catch(error){await audit(req.session.authUserId,'discord',false,error.message);return redirect(res,'error',`Discord test failed: ${error.message}`);}
  });

  return r;
}

module.exports={createAdminPersonalNotificationTestsRouter,identity,testText};
