'use strict';

const express=require('express');
const {query}=require('../db');
const csrf=require('../auth/csrf');
const routeRateLimit=require('../security/route-rate-limit');
const registry=require('../jellyfin/registry');
const mediaProvider=require('../media-servers/provider');
const outbound=require('../security/outbound-url-policy');

const readLimit=routeRateLimit.middleware({scope:'admin-dashboard-live-streams-read',max:120,windowSeconds:60,reason:'admin_dashboard_live_streams_read'});
const writeLimit=routeRateLimit.middleware({scope:'admin-dashboard-live-streams-control',max:60,windowSeconds:60,reason:'admin_dashboard_live_streams_control'});
const MAX_IMAGE_BYTES=5*1024*1024;

function gate(req,res,next){
  if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();
  return res.status(401).json({error:'Admin session required.'});
}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function cleanText(value,max,label){
  const text=String(value||'').trim();
  if(!text)throw new Error(`${label} is required.`);
  if(text.length>max)throw new Error(`${label} must be ${max} characters or fewer.`);
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))throw new Error(`${label} contains unsupported control characters.`);
  return text;
}
function cleanSessionId(value){
  const id=String(value||'').trim();
  if(!id||id.length>256||/[\u0000-\u001f\u007f/\\]/.test(id))throw new Error('Invalid media session.');
  return id;
}
function cleanItemId(value){
  const id=String(value||'').trim();
  if(!id||id.length>160||!/^[-A-Za-z0-9_:.]+$/.test(id))throw new Error('Invalid media item.');
  return id;
}
function ticksToSeconds(value){const n=Number(value);return Number.isFinite(n)&&n>=0?Math.floor(n/10000000):null;}
function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function playbackMethod(session){
  const value=String(session?.PlayState?.PlayMethod||'').toLowerCase();
  if(value==='directplay')return'Direct Play';
  if(value==='directstream')return'Direct Stream';
  if(value==='transcode'||session?.TranscodingInfo)return'Transcode';
  return'Playing';
}
function resolutionLabel(width,height){
  const w=Number(width||0),h=Number(height||0);
  if(w>=3800||h>=2100)return'4K';
  if(w>=2500||h>=1400)return'1440p';
  if(w>=1900||h>=1000)return'1080p';
  if(w>=1200||h>=700)return'720p';
  if(w||h)return`${h||w}p`;
  return null;
}
function episodeCode(item){
  if(String(item?.Type||'').toLowerCase()!=='episode')return null;
  const season=Number(item?.ParentIndexNumber),episode=Number(item?.IndexNumber);
  if(!Number.isFinite(season)&&!Number.isFinite(episode))return null;
  return `${Number.isFinite(season)?`S${String(season).padStart(2,'0')}`:''}${Number.isFinite(episode)?` E${String(episode).padStart(2,'0')}`:''}`.trim();
}
function mediaStreams(item){return Array.isArray(item?.MediaStreams)?item.MediaStreams:[];}
function primaryImageItem(item){
  if(item?.SeriesId&&item?.SeriesPrimaryImageTag)return String(item.SeriesId);
  if(item?.ParentId&&item?.ParentPrimaryImageTag)return String(item.ParentId);
  if(item?.Id&&(item?.ImageTags?.Primary||item?.PrimaryImageTag))return String(item.Id);
  return null;
}
function remoteAddress(value){
  const raw=String(value||'').trim();
  if(!raw)return null;
  const mapped=raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/i);if(mapped)return mapped[1];
  if(raw.startsWith('[')){const end=raw.indexOf(']');return end>0?raw.slice(1,end):raw.slice(0,160);}
  const ipv4WithPort=raw.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);if(ipv4WithPort)return ipv4WithPort[1];
  return raw.slice(0,160);
}

async function managedAccounts(){
  const rows=await query(`
    SELECT ja.server_id,ja.jellyfin_user_id,ja.customer_id,ja.jellyfin_username,
           c.display_name,c.email,au.username AS login_username
    FROM jellyfin_accounts ja
    JOIN jellyfin_servers js ON js.id=ja.server_id AND js.enabled=TRUE
    JOIN customers c ON c.id=ja.customer_id
    LEFT JOIN app_users au ON au.id=c.user_id
    WHERE COALESCE(ja.account_purpose,'jellyfin')<>'stremio_internal' AND ja.disabled=FALSE
  `);
  const byServer=new Map();
  for(const row of rows.rows){
    const key=String(row.server_id),user=String(row.jellyfin_user_id||'').toLowerCase();
    if(!byServer.has(key))byServer.set(key,new Map());
    byServer.get(key).set(user,row);
  }
  return byServer;
}

function normalizeLiveSession(server,account,session){
  const item=session?.NowPlayingItem||{},streams=mediaStreams(item),video=streams.find(row=>String(row.Type||'').toLowerCase()==='video')||{},audio=streams.find(row=>String(row.Type||'').toLowerCase()==='audio')||{},trans=session?.TranscodingInfo||{};
  const width=Number(trans.Width||video.Width||0)||null,height=Number(trans.Height||video.Height||0)||null;
  const duration=ticksToSeconds(item.RunTimeTicks),position=ticksToSeconds(session?.PlayState?.PositionTicks);
  const title=item.SeriesName||item.Name||'Playing media',ep=episodeCode(item),subtitle=String(item.Type||'').toLowerCase()==='episode'
    ? [ep,item.Name].filter(Boolean).join(' · ')
    : [item.ProductionYear].filter(Boolean).join('');
  const imageItemId=primaryImageItem(item);
  const transcodeReasons=Array.isArray(trans.TranscodeReasons)?trans.TranscodeReasons.map(String):[];
  return{
    serverId:String(server.id),serverName:String(server.name||'Media server'),service:mediaProvider.label(server.media_server_type||'jellyfin'),
    sessionId:String(session.Id),customerId:String(account.customer_id),user:account.display_name||account.email||account.login_username||account.jellyfin_username||'Customer',email:account.email||null,
    title,subtitle:subtitle||null,type:String(item.Type||'Media'),year:item.ProductionYear||null,
    client:session.Client?String(session.Client):null,device:session.DeviceName?String(session.DeviceName):null,applicationVersion:session.ApplicationVersion?String(session.ApplicationVersion):null,
    remoteAddress:remoteAddress(session.RemoteEndPoint),isLocal:Boolean(session.IsLocal),paused:Boolean(session?.PlayState?.IsPaused),supportsControl:session.SupportsMediaControl===true,
    method:playbackMethod(session),positionSeconds:position,durationSeconds:duration,progressPercent:duration&&position!=null?Math.max(0,Math.min(100,position/duration*100)):null,
    bitrate:Number(trans.Bitrate||item.Bitrate||0)||null,width,height,resolution:resolutionLabel(width,height),videoCodec:video.Codec?String(video.Codec).toUpperCase():null,audioCodec:audio.Codec?String(audio.Codec).toUpperCase():null,audioChannels:Number(audio.Channels||0)||null,
    transcodeReasons,lastActivityAt:session.LastActivityDate||null,
    imageUrl:imageItemId?`/admin/live-streams/server/${encodeURIComponent(server.id)}/item/${encodeURIComponent(imageItemId)}/primary-image`:null
  };
}

async function liveSessionsSnapshot(){
  const [servers,accountsByServer]=await Promise.all([registry.listServers({enabledOnly:true}),managedAccounts()]);
  const failures=[];
  const groups=await Promise.all(servers.map(async server=>{
    const accounts=accountsByServer.get(String(server.id))||new Map();
    if(!accounts.size)return[];
    try{
      const sessions=await registry.request(server.id,'/Sessions?activeWithinSeconds=180',{timeoutMs:5000});
      if(!Array.isArray(sessions))throw new Error('Unexpected sessions response');
      return sessions.filter(session=>session?.Id&&session?.UserId&&session?.NowPlayingItem&&accounts.has(String(session.UserId).toLowerCase())).map(session=>normalizeLiveSession(server,accounts.get(String(session.UserId).toLowerCase()),session));
    }catch(error){failures.push({serverId:String(server.id),serverName:String(server.name||'Media server'),error:'Live sessions unavailable'});return[];}
  }));
  const streams=groups.flat().sort((a,b)=>Number(a.paused)-Number(b.paused)||String(a.serverName).localeCompare(String(b.serverName))||String(a.user).localeCompare(String(b.user)));
  return{streams,failures,refreshedAt:new Date().toISOString()};
}

async function managedLiveSession(serverId,sessionId){
  const id=cleanSessionId(sessionId),server=(await registry.listServers({enabledOnly:true})).find(row=>String(row.id)===String(serverId));
  if(!server)throw new Error('Media server is unavailable.');
  const accountsByServer=await managedAccounts(),accounts=accountsByServer.get(String(server.id))||new Map();
  const sessions=await registry.request(server.id,'/Sessions?activeWithinSeconds=180',{timeoutMs:5000});
  if(!Array.isArray(sessions))throw new Error('Active sessions could not be loaded.');
  const session=sessions.find(row=>String(row?.Id||'')===id&&row?.UserId&&accounts.has(String(row.UserId).toLowerCase())&&row?.NowPlayingItem);
  if(!session)throw new Error('That stream is no longer active.');
  return{server,account:accounts.get(String(session.UserId).toLowerCase()),session};
}

async function auditControl(req,action,target,detail={}){
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'customer',$3,$4::jsonb)`,[
    req.session.authUserId,action,target.account.customer_id,JSON.stringify({serverId:target.server.id,provider:target.server.media_server_type||'jellyfin',sessionId:String(target.session.Id),itemId:target.session?.NowPlayingItem?.Id||null,...detail})
  ]);
}

async function serverSessions(serverId){
  const sessions=await registry.request(serverId,'/Sessions?activeWithinSeconds=180',{timeoutMs:5000});
  if(!Array.isArray(sessions))throw new Error('Active sessions could not be revalidated.');
  return sessions.filter(session=>session?.Id&&session?.NowPlayingItem);
}
async function stopManagedSession(target){
  let directError=null;
  try{await registry.request(target.server.id,`/Sessions/${encodeURIComponent(target.session.Id)}/Playing/Stop`,{method:'POST',timeoutMs:5000});}catch(error){directError=error;}
  await delay(750);
  let fresh=await serverSessions(target.server.id),still=fresh.find(row=>String(row.Id)===String(target.session.Id));
  if(!still)return{method:'playback_stop',directError:directError?.message||null};
  const deviceId=still.DeviceId||target.session.DeviceId||null;
  if(!deviceId)throw new Error(directError?.message||'The client ignored the stop command and did not expose a safe device fallback.');
  const sameDevice=fresh.filter(row=>String(row.Id)!==String(target.session.Id)&&String(row.DeviceId||'')===String(deviceId));
  if(sameDevice.length)throw new Error('The client ignored Stop. CAPTAiNFiN did not sign the device out because another active stream is using the same device.');
  await registry.request(target.server.id,`/Devices?id=${encodeURIComponent(deviceId)}`,{method:'DELETE',timeoutMs:5000});
  await delay(750);fresh=await serverSessions(target.server.id);still=fresh.find(row=>String(row.Id)===String(target.session.Id));
  if(still)throw new Error('The media server accepted Stop and device sign-out, but the stream is still active.');
  return{method:'device_logout_fallback',directError:directError?.message||null};
}

async function controlSession(req,res){
  if(!csrf.verify(req))return res.status(403).json({error:'Invalid or expired security token.'});
  try{
    const target=await managedLiveSession(req.params.serverId,req.params.sessionId),action=String(req.body?.action||'').toLowerCase();
    const paused=Boolean(target.session?.PlayState?.IsPaused);
    if(action==='stop'){
      const stopped=await stopManagedSession(target);await auditControl(req,'admin.live_stream.stop',target,{previousPaused:paused,stopMethod:stopped.method,directStopError:stopped.directError});return res.json({ok:true,action,method:stopped.method});
    }
    let endpoint,auditAction;
    if(action==='pause'){if(paused)return res.json({ok:true,state:'paused'});endpoint=`/Sessions/${encodeURIComponent(target.session.Id)}/Playing/Pause`;auditAction='admin.live_stream.pause';}
    else if(action==='resume'){if(!paused)return res.json({ok:true,state:'playing'});endpoint=`/Sessions/${encodeURIComponent(target.session.Id)}/Playing/Unpause`;auditAction='admin.live_stream.resume';}
    else return res.status(400).json({error:'Choose pause, resume or stop.'});
    if(target.session.SupportsMediaControl!==true)return res.status(409).json({error:'This client does not advertise pause/resume control.'});
    await registry.request(target.server.id,endpoint,{method:'POST',timeoutMs:5000});
    await auditControl(req,auditAction,target,{previousPaused:paused});
    return res.json({ok:true,action});
  }catch(error){return res.status(409).json({error:error.message||'Stream control failed.'});}
}

async function messageSession(req,res){
  if(!csrf.verify(req))return res.status(403).json({error:'Invalid or expired security token.'});
  try{
    const target=await managedLiveSession(req.params.serverId,req.params.sessionId),header=cleanText(req.body?.header||'Message from administrator',80,'Message title'),text=cleanText(req.body?.text,500,'Message'),seconds=Number(req.body?.timeoutSeconds||8),timeoutSeconds=Number.isInteger(seconds)&&seconds>=3&&seconds<=30?seconds:8;
    await registry.request(target.server.id,`/Sessions/${encodeURIComponent(target.session.Id)}/Message`,{method:'POST',timeoutMs:5000,body:{Header:header,Text:text,TimeoutMs:timeoutSeconds*1000}});
    await auditControl(req,'admin.live_stream.message',target,{header,textLength:text.length,timeoutSeconds});
    return res.json({ok:true});
  }catch(error){return res.status(409).json({error:error.message||'Message could not be sent.'});}
}

async function primaryImage(req,res){
  try{
    const itemId=cleanItemId(req.params.itemId),server=await registry.getServerSecret(req.params.serverId);
    if(!server||!server.enabled)return res.status(404).end();
    const endpoint=`/Items/${encodeURIComponent(itemId)}/Images/Primary?maxWidth=240&quality=85`,url=mediaProvider.apiUrl(server.base_url,server.media_server_type,endpoint);
    const response=await outbound.safeFetch(url,{purpose:`${mediaProvider.label(server.media_server_type)} artwork for admin live streams`,method:'GET',timeoutMs:5000,headers:{...registry.authHeaders(server.apiKey,{mediaServerType:server.media_server_type}),Accept:'image/*'}});
    if(!response.ok)return res.status(response.status===404?404:502).end();
    const contentType=String(response.headers.get('content-type')||'');
    if(!contentType.toLowerCase().startsWith('image/'))return res.status(502).end();
    const declared=Number(response.headers.get('content-length')||0);if(declared>MAX_IMAGE_BYTES)return res.status(413).end();
    const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>MAX_IMAGE_BYTES)return res.status(413).end();
    res.setHeader('Content-Type',contentType);res.setHeader('Cache-Control','private, max-age=60');return res.send(bytes);
  }catch(_){return res.status(404).end();}
}

function renderLiveStreamsPanel(req){
  return `<link rel="stylesheet" href="/css/admin-dashboard-live-streams.css"><section class="adminLiveStreams" data-admin-live-streams data-csrf-token="${csrf.token(req)}" aria-live="polite"><div class="adminLiveStreamsHeader"><div><span class="adminLiveStreamsEyebrow">Live playback</span><div class="adminLiveStreamsHeading"><span class="adminLiveStreamsPulse" aria-hidden="true"></span><h2>Now Playing</h2><span class="adminLiveStreamsCount" data-live-stream-count>Loading…</span></div></div><div class="adminLiveStreamsHeaderMeta" data-live-stream-meta>Across enabled Jellyfin and Emby servers</div></div><div class="notice error adminLiveStreamsError" data-live-stream-error hidden></div><div class="adminLiveStreamsGrid" data-live-stream-grid><div class="adminLiveStreamsLoading">Loading active streams…</div></div></section><script src="/js/admin-dashboard-live-streams.js" defer></script>`;
}

function createAdminDashboardLiveStreamsRouter(){
  const router=express.Router();router.use('/admin/live-streams',gate,noStore);
  router.get('/admin/live-streams',readLimit,async(_req,res,next)=>{try{return res.json(await liveSessionsSnapshot());}catch(error){return next(error);}});
  router.get('/admin/live-streams/server/:serverId/item/:itemId/primary-image',readLimit,(req,res)=>primaryImage(req,res));
  router.post('/admin/live-streams/server/:serverId/session/:sessionId/control',writeLimit,(req,res)=>controlSession(req,res));
  router.post('/admin/live-streams/server/:serverId/session/:sessionId/message',writeLimit,(req,res)=>messageSession(req,res));
  router.use('/admin/live-streams',(_error,_req,res,_next)=>{if(res.headersSent)return;return res.status(500).json({error:'Live stream controls are temporarily unavailable.'});});
  return router;
}

module.exports={createAdminDashboardLiveStreamsRouter,renderLiveStreamsPanel,liveSessionsSnapshot,normalizeLiveSession,managedLiveSession,controlSession,messageSession,stopManagedSession,resolutionLabel,ticksToSeconds,cleanSessionId,cleanText,remoteAddress};
