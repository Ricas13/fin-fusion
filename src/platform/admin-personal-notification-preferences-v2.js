'use strict';

const express=require('express');
const {query,transaction}=require('../db');
const csrf=require('../auth/csrf');
const runtimeSettings=require('./runtime-settings');
const operations=require('./operations-settings');
const reportingCurrency=require('./reporting-currency');
const emailSettings=require('../integrations/email-settings');
const notificationSettings=require('../integrations/notification-settings');
const adminLinks=require('../integrations/admin-channel-links');
const adminPolicy=require('../integrations/notification-admin-policy');
const {layout,esc}=require('./admin-html');

const CHANNELS=['email','telegram','discord'];
const GROUP_ORDER=adminPolicy.GROUP_ORDER;
function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function token(req){return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`;}
function notice(req){return `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`;}
function group(eventType){return adminPolicy.group(eventType);}
function statusPill(label,kind){return `<span class="pill ${kind||''}">${esc(label)}</span>`;}

async function data(req){
  const [user,communication,events,prefs,email,delivery,adminDiscordRedirect]=await Promise.all([
    query(`SELECT id,username,email FROM app_users WHERE id=$1 AND role='admin'`,[req.session.authUserId]),
    query(`SELECT * FROM admin_communication_preferences WHERE admin_user_id=$1`,[req.session.authUserId]),
    query(`SELECT event_type,display_name,description,email_enabled,telegram_enabled,discord_enabled FROM notification_preferences WHERE event_scope IN ('admin','both') ORDER BY event_type`),
    query(`SELECT event_type,channel,enabled FROM admin_notification_preferences WHERE admin_user_id=$1`,[req.session.authUserId]),
    emailSettings.status().catch(()=>({configured:false})),
    notificationSettings.status().catch(()=>({})),
    operations.absoluteUrl(req,'/admin/profile/notifications/discord/callback',{requireCanonical:false})
  ]);
  const selected={};
  for(const event of events.rows){const enabled=adminPolicy.defaultEnabled(event.event_type);selected[event.event_type]=Object.fromEntries(CHANNELS.map(channel=>[channel,enabled]));}
  for(const row of prefs.rows){if(!selected[row.event_type])selected[row.event_type]={};selected[row.event_type][row.channel]=Boolean(row.enabled);}
  return{user:user.rows[0]||{},communication:communication.rows[0]||{},events:events.rows,selected,email,delivery,adminDiscordRedirect};
}

function channelCard(req,d,channel){
  const c=d.communication,user=d.user,delivery=d.delivery;
  if(channel==='email'){
    const global=Boolean(d.email?.configured),personal=Boolean(user.email),ready=global&&personal;
    return `<div class="serverCard"><div class="serverTop"><div><strong>Email</strong><div class="subText">${esc(user.email||'No administrator email set')}</div></div>${statusPill(ready?'Ready':!global?'Unavailable globally':'Email needed',ready?'good':'warn')}</div><div class="card-body"><div class="subText">Email is your account contact address; change it on Profile, not on this notification page.</div><div class="buttonRow" style="margin-top:12px"><a class="button secondary btn-sm" href="/admin/profile">Profile</a>${ready?`<form method="post" action="/admin/profile/notifications/test/email">${token(req)}<button class="button secondary btn-sm">Send test</button></form>`:''}${!global?'<a class="button secondary btn-sm" href="/admin/notifications/email">Configure globally</a>':''}</div></div></div>`;
  }
  if(channel==='telegram'){
    const global=Boolean(delivery.telegramConfigured),personal=Boolean(c.telegram_chat_id),ready=global&&personal;
    return `<div class="serverCard"><div class="serverTop"><div><strong>Telegram</strong><div class="subText">${personal?`Connected${c.telegram_handle?` as @${esc(c.telegram_handle)}`:''}`:'Not connected'}</div></div>${statusPill(ready?'Ready':!global?'Unavailable globally':'Connect account',ready?'good':'warn')}</div><div class="card-body"><div class="buttonRow">${personal?`<form method="post" action="/admin/profile/notifications/telegram/unlink">${token(req)}<button class="button secondary btn-sm">Disconnect</button></form>${global?`<form method="post" action="/admin/profile/notifications/test/telegram">${token(req)}<button class="button secondary btn-sm">Send test</button></form>`:''}`:global&&delivery.telegramBotUsername?`<form method="post" action="/admin/profile/notifications/telegram/start" data-native-submit="true">${token(req)}<button class="button btn-sm">Connect Telegram</button></form>`:'<a class="button secondary btn-sm" href="/admin/notifications/preferences">Configure globally</a>'}</div></div></div>`;
  }
  if(channel==='discord'){
    const global=Boolean(delivery.discordConfigured&&delivery.discordClientId),personal=Boolean(c.discord_user_id),ready=global&&personal;
    return `<div class="serverCard"><div class="serverTop"><div><strong>Discord</strong><div class="subText">${personal?`Connected${c.discord_handle?` as ${esc(c.discord_handle)}`:''}`:'Not connected'}</div></div>${statusPill(ready?'Ready':!global?'Unavailable globally':'Connect account',ready?'good':'warn')}</div><div class="card-body"><div class="buttonRow">${personal?`<form method="post" action="/admin/profile/notifications/discord/unlink">${token(req)}<button class="button secondary btn-sm">Disconnect</button></form>${global?`<form method="post" action="/admin/profile/notifications/test/discord">${token(req)}<button class="button secondary btn-sm">Send test</button></form>`:''}`:global?`<form method="post" action="/admin/profile/notifications/discord/start" data-native-submit="true">${token(req)}<button class="button btn-sm">Connect Discord</button></form>`:'<a class="button secondary btn-sm" href="/admin/notifications/preferences">Configure globally</a>'}</div>${global?`<details class="detailsBox" style="margin-top:10px"><summary>Discord OAuth setup reference</summary><div class="subText">Admin redirect URI</div><code>${esc(d.adminDiscordRedirect)}</code></details>`:''}</div></div>`;
  }
  return '';
}

function eventGroups(d){
  const groups=new Map();
  for(const event of d.events){const key=group(event.event_type);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(event);}
  const ordered=[...groups.entries()].sort((a,b)=>{const ai=GROUP_ORDER.indexOf(a[0]),bi=GROUP_ORDER.indexOf(b[0]);return (ai<0?999:ai)-(bi<0?999:bi)||a[0].localeCompare(b[0]);});
  return ordered.map(([name,events],index)=>`<details class="notificationEventGroup detailsBox" ${index<2?'open':''}><summary><strong>${esc(name)}</strong><span class="muted">${events.length} event${events.length===1?'':'s'} · ${name==='Money'||name==='Access'?'default on':'default off'}</span></summary><div class="tableWrap"><table class="dataTable"><thead><tr><th>Event</th><th>Email</th><th>Telegram</th><th>Discord</th></tr></thead><tbody>${events.map(event=>{const p=d.selected[event.event_type]||{};return `<tr><td><strong>${esc(event.display_name||event.event_type)}</strong><div class="subText">${esc(event.description||event.event_type)}</div></td>${CHANNELS.map(channel=>{const allowed=Boolean(event[`${channel}_enabled`]);return `<td title="${allowed?'Available globally':'Disabled globally'}"><input type="checkbox" name="${channel}__${esc(event.event_type)}" ${allowed&&p[channel]?'checked':''} ${allowed?'':'disabled'} aria-label="${esc(channel)} for ${esc(event.display_name||event.event_type)}"></td>`;}).join('')}</tr>`;}).join('')}</tbody></table></div></details>`).join('');
}

async function page(req){
  await runtimeSettings.ensureLoaded();const d=await data(req);
  const body=`${notice(req)}<div class="operatorCallout"><strong>These choices belong only to you.</strong> Global notification settings decide which channels and events CAPTAiNFiN is allowed to send. Here you connect your own destinations and choose what reaches this administrator account.</div><section class="section"><div class="sectionHead"><div><h2>Your delivery channels</h2><div class="muted">Connect once, test here, then choose events below.</div></div><a class="button secondary btn-sm" href="/admin/notifications/preferences">Global notification settings</a></div><div class="serverGrid notificationIdentityGrid">${CHANNELS.map(channel=>channelCard(req,d,channel)).join('')}</div></section><section class="section"><div class="sectionHead"><div><h2>Your event routing</h2><div class="muted">Money and Access start on for administrators. Growth and Noise start off; login/session events never become chat noise unless you explicitly select them.</div></div><span class="pill accent">Defaults are editable</span></div><form class="formPanel" method="post" action="/admin/profile/notifications">${token(req)}<div class="notificationEventGroups">${eventGroups(d)}</div><div class="buttonRow" style="margin-top:16px"><button class="button">Save my notifications</button></div></form></section><style>.notificationIdentityGrid{padding:16px}.notificationIdentityGrid .card-body{padding:14px}.notificationIdentityGrid form{margin:0}.notificationEventGroups{display:grid;gap:10px}.notificationEventGroup>summary{display:flex;justify-content:space-between;gap:14px;align-items:center;cursor:pointer;padding:13px 14px}.notificationEventGroup .tableWrap{border-top:1px solid var(--border-soft)}.notificationEventGroup table{margin:0}@media(max-width:760px){.notificationEventGroup .tableWrap{overflow-x:auto}.notificationEventGroup table{min-width:620px}}</style>`;
  return layout({siteName:runtimeSettings.siteName(),active:'my-notifications',title:'My notification preferences',subtitle:'Personal delivery channels and event routing',body});
}

async function savePreferences(req,res){
  if(!csrf.verify(req))return res.status(403).send('Invalid security token');
  try{
    const events=(await query(`SELECT event_type,email_enabled,telegram_enabled,discord_enabled FROM notification_preferences WHERE event_scope IN ('admin','both') ORDER BY event_type`)).rows;
    await transaction(async client=>{
      for(const event of events){for(const channel of CHANNELS){const globalEnabled=Boolean(event[`${channel}_enabled`]),enabled=globalEnabled&&String(req.body[`${channel}__${event.event_type}`]||'')==='on';await client.query(`INSERT INTO admin_notification_preferences(admin_user_id,event_type,channel,enabled) VALUES($1,$2,$3,$4) ON CONFLICT(admin_user_id,event_type,channel) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=NOW()`,[req.session.authUserId,event.event_type,channel,enabled]);}}
      await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.notifications.personal.update','app_user',$2,$3::jsonb)`,[req.session.authUserId,String(req.session.authUserId),JSON.stringify({eventCount:events.length})]);
    });
    return res.redirect('/admin/profile/notifications?message='+encodeURIComponent('Your notification preferences were saved.'));
  }catch(error){return res.redirect('/admin/profile/notifications?error='+encodeURIComponent(error.message||'Notification preferences could not be saved.'));}
}

function createAdminPersonalNotificationPreferencesRouter(){
  const r=express.Router();r.use('/admin/profile/notifications',gate,noStore);
  r.get('/admin/profile/notifications',async(req,res,next)=>{try{return res.send(await page(req));}catch(error){next(error);}});
  r.post('/admin/profile/notifications',savePreferences);
  r.post('/admin/profile/notifications/currency',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await reportingCurrency.saveUserCurrency(req.session.authUserId,req.body.currency,req.session.authUserId);return res.redirect('/admin/profile?message='+encodeURIComponent('Reporting currency saved.'));}catch(error){return res.redirect('/admin/profile?error='+encodeURIComponent(error.message));}});
  r.post('/admin/profile/notifications/telegram/start',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const cfg=await notificationSettings.status();if(!cfg.telegramConfigured||!cfg.telegramBotUsername)throw new Error('Telegram is not available globally yet.');const issued=await adminLinks.issue(req.session.authUserId,'telegram');return res.redirect(`https://t.me/${encodeURIComponent(cfg.telegramBotUsername)}?start=${encodeURIComponent(issued.token)}`);}catch(error){return res.redirect('/admin/profile/notifications?error='+encodeURIComponent(error.message));}});
  r.post('/admin/profile/notifications/telegram/unlink',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');await adminLinks.unlink(req.session.authUserId,'telegram');return res.redirect('/admin/profile/notifications?message='+encodeURIComponent('Telegram disconnected. Your event selections were kept for a future reconnect.'));});
  r.post('/admin/profile/notifications/discord/start',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const cfg=await notificationSettings.status();if(!cfg.discordConfigured||!cfg.discordClientId)throw new Error('Discord is not available globally yet.');const issued=await adminLinks.issue(req.session.authUserId,'discord'),redirectUri=await operations.absoluteUrl(req,'/admin/profile/notifications/discord/callback'),url=new URL('https://discord.com/oauth2/authorize');url.searchParams.set('client_id',cfg.discordClientId);url.searchParams.set('response_type','code');url.searchParams.set('redirect_uri',redirectUri);url.searchParams.set('scope','identify');url.searchParams.set('state',issued.token);return res.redirect(url.toString());}catch(error){return res.redirect('/admin/profile/notifications?error='+encodeURIComponent(error.message));}});
  r.get('/admin/profile/notifications/discord/callback',async(req,res)=>{try{if(req.query.error){const providerError=String(req.query.error);if(providerError==='access_denied')throw new Error('Discord connection was cancelled. Nothing changed.');throw new Error('Discord did not complete the connection. Start the connection again.');}const code=String(req.query.code||''),state=String(req.query.state||'');if(!code||!state)throw new Error('Discord did not return a complete authorization response. Start the connection again.');const pending=await adminLinks.inspect(state,'discord');if(!pending)throw new Error('This Discord connection request expired or was already used. Click Connect Discord to start again.');if(String(pending.adminUserId)!==String(req.session.authUserId))throw new Error('This Discord connection request belongs to another administrator session. Start a new connection from this profile.');const redirectUri=await operations.absoluteUrl(req,'/admin/profile/notifications/discord/callback'),user=await notificationSettings.exchangeDiscordCode(code,redirectUri),handle=user.global_name||user.username||user.id,linked=await adminLinks.linkDiscord(state,{userId:user.id,handle});if(!linked||String(linked.adminUserId)!==String(req.session.authUserId))throw new Error('The Discord connection expired before it could be saved. Start again.');return res.redirect('/admin/profile/notifications?message='+encodeURIComponent(`Discord connected as ${handle}.`));}catch(error){return res.redirect('/admin/profile/notifications?error='+encodeURIComponent(error.message||'Discord could not be connected.'));}});
  r.post('/admin/profile/notifications/discord/unlink',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');await adminLinks.unlink(req.session.authUserId,'discord');return res.redirect('/admin/profile/notifications?message='+encodeURIComponent('Discord disconnected. Your event selections were kept for a future reconnect.'));});
  return r;
}
module.exports={createAdminPersonalNotificationPreferencesRouter,page,data,eventGroups,group};