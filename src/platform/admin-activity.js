'use strict';

const express=require('express');
const {query}=require('../db');
const activity=require('../jellyfin/activity');
const streamPolicy=require('../jellyfin/stream-policy-settings');
const runtimeSettings=require('./runtime-settings');
const csrf=require('../auth/csrf');
const ui=require('./admin-ui');
const {esc}=require('./admin-html');

const SAFETY_ISSUE_REASONS=new Set([
  'incomplete_server_snapshot',
  'revalidation_failed',
  'client_does_not_report_media_control_support'
]);

function requireAdminSession(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private');res.setHeader('Pragma','no-cache');next();}
function withinHours(value,hours=24){const at=new Date(value).getTime();return Number.isFinite(at)&&at>=Date.now()-(hours*60*60*1000);}
function reasonLabel(value){const key=String(value||'');const labels={
  grace_period:'Grace period still running',
  confirmation_threshold:'Waiting for confirmation threshold',
  incomplete_server_snapshot:'Server snapshot incomplete',
  enforcement_ack_missing:'Enforcement acknowledgement missing',
  observe_only:'Observe / warn mode only',
  revalidation_failed:'Live session revalidation failed',
  violation_cleared_before_action:'Limit violation cleared before action',
  candidate_changed_before_action:'Playback changed before action',
  client_does_not_report_media_control_support:'Client cannot confirm media-control support',
  confirmed_concurrent_stream_limit:'Confirmed concurrent stream limit',
  jellyfin_stop_failed:'Jellyfin stop request failed'
};return labels[key]||key.replaceAll('_',' ')||'Policy decision';}
function decisionLabel(value){const labels={would_stop:'Would stop',stopped:'Stopped playback',stop_failed:'Stop failed',skipped_safety:'Safety skip',pending:'Pending confirmation'};return labels[value]||String(value||'Policy event').replaceAll('_',' ');}
function eventTone(event){if(event.decision==='stop_failed')return'bad';if(event.decision==='would_stop')return'warn';if(event.decision==='skipped_safety'&&SAFETY_ISSUE_REASONS.has(event.reason))return'warn';if(event.decision==='stopped')return'accent';return'good';}

async function dashboardData(cfg){
  const[summaryResult,streamsResult,serversResult,significantEventsResult,eventsResult,historyResult]=await Promise.all([
    query(`SELECT
      (SELECT COUNT(*)::int FROM active_playback_sessions) AS active_streams,
      (SELECT COUNT(*)::int FROM active_playback_sessions WHERE playback_method='transcode') AS transcodes,
      (SELECT COUNT(*)::int FROM stream_policy_events WHERE created_at>=NOW()-INTERVAL '24 hours' AND decision IN('would_stop','stopped','stop_failed')) AS violations_24h,
      (SELECT COUNT(*)::int FROM stream_policy_events WHERE created_at>=NOW()-INTERVAL '24 hours' AND decision='stopped') AS stopped_24h,
      (SELECT COUNT(*)::int FROM stream_policy_events WHERE created_at>=NOW()-INTERVAL '24 hours' AND decision='stop_failed') AS stop_failures_24h,
      (SELECT COUNT(*)::int FROM stream_policy_events WHERE created_at>=NOW()-INTERVAL '24 hours' AND decision='skipped_safety') AS safety_skips_24h,
      (SELECT COUNT(*)::int FROM stream_policy_events WHERE created_at>=NOW()-INTERVAL '24 hours' AND decision='skipped_safety' AND reason IN('incomplete_server_snapshot','revalidation_failed','client_does_not_report_media_control_support')) AS safety_issues_24h,
      (SELECT COUNT(*)::int FROM jellyfin_servers WHERE enabled=TRUE) AS enabled_servers,
      (SELECT COUNT(*)::int FROM jellyfin_servers WHERE enabled=TRUE AND health_status='offline') AS offline_servers`),
    query(`SELECT aps.server_id,aps.jellyfin_session_id,aps.customer_id,aps.item_name,aps.item_type,aps.client_name,aps.device_name,aps.playback_method,aps.is_paused,aps.first_seen_at,aps.last_seen_at,aps.stream_limit,js.name AS server_name,ja.jellyfin_username,COALESCE(NULLIF(c.display_name,''),au.username,ja.jellyfin_username,'Customer') AS customer_name FROM active_playback_sessions aps JOIN jellyfin_servers js ON js.id=aps.server_id LEFT JOIN jellyfin_accounts ja ON ja.id=aps.jellyfin_account_id LEFT JOIN customers c ON c.id=aps.customer_id LEFT JOIN app_users au ON au.id=c.user_id ORDER BY aps.first_seen_at ASC LIMIT 250`),
    query(`SELECT js.id,js.name,js.server_class,js.enabled,js.max_users,js.health_status,js.last_health_check,js.placement_mode,COUNT(DISTINCT ja.id)::int AS assigned_users,COUNT(DISTINCT aps.jellyfin_session_id)::int AS active_streams FROM jellyfin_servers js LEFT JOIN jellyfin_accounts ja ON ja.server_id=js.id AND ja.disabled=FALSE LEFT JOIN active_playback_sessions aps ON aps.server_id=js.id GROUP BY js.id ORDER BY js.priority,js.name`),
    query(`SELECT spe.server_id,spe.customer_id,spe.decision,spe.mode,spe.stream_count,spe.stream_limit,spe.reason,spe.created_at,js.name AS server_name,COALESCE(NULLIF(c.display_name,''),au.username,ja.jellyfin_username,'Customer') AS customer_name FROM stream_policy_events spe LEFT JOIN jellyfin_servers js ON js.id=spe.server_id LEFT JOIN jellyfin_accounts ja ON ja.id=spe.jellyfin_account_id LEFT JOIN customers c ON c.id=spe.customer_id LEFT JOIN app_users au ON au.id=c.user_id WHERE spe.decision IN('would_stop','stopped','stop_failed','skipped_safety') ORDER BY spe.created_at DESC LIMIT 100`),
    query(`SELECT spe.server_id,spe.customer_id,spe.decision,spe.mode,spe.stream_count,spe.stream_limit,spe.reason,spe.created_at,js.name AS server_name,COALESCE(NULLIF(c.display_name,''),au.username,ja.jellyfin_username,'Customer') AS customer_name FROM stream_policy_events spe LEFT JOIN jellyfin_servers js ON js.id=spe.server_id LEFT JOIN jellyfin_accounts ja ON ja.id=spe.jellyfin_account_id LEFT JOIN customers c ON c.id=spe.customer_id LEFT JOIN app_users au ON au.id=c.user_id ORDER BY spe.created_at DESC LIMIT 100`),
    query(`SELECT ph.item_name,ph.item_type,ph.client_name,ph.device_name,ph.playback_method,ph.started_at,ph.ended_at,ph.ended_reason,js.name AS server_name,COALESCE(NULLIF(c.display_name,''),au.username,ja.jellyfin_username,'Customer') AS customer_name FROM playback_history ph JOIN jellyfin_servers js ON js.id=ph.server_id LEFT JOIN jellyfin_accounts ja ON ja.id=ph.jellyfin_account_id LEFT JOIN customers c ON c.id=ph.customer_id LEFT JOIN app_users au ON au.id=c.user_id ORDER BY ph.started_at DESC LIMIT 80`)
  ]);
  const streams=streamsResult.rows,counts=new Map();
  for(const stream of streams){if(!stream.customer_id)continue;if(!cfg.countPaused&&stream.is_paused)continue;counts.set(stream.customer_id,(counts.get(stream.customer_id)||0)+1);}
  for(const stream of streams)stream.customer_stream_count=counts.get(stream.customer_id)||0;
  return{summary:summaryResult.rows[0],streams,servers:serversResult.rows,significantEvents:significantEventsResult.rows,events:eventsResult.rows,history:historyResult.rows};
}

function playbackState(data){
  const overLimit=new Map();
  for(const stream of data.streams){
    const limit=Number(stream.stream_limit),count=Number(stream.customer_stream_count||0);
    if(!stream.customer_id||!Number.isFinite(limit)||limit<1||count<=limit)continue;
    if(!overLimit.has(stream.customer_id))overLimit.set(stream.customer_id,{customerId:stream.customer_id,customerName:stream.customer_name||'Customer',streamCount:count,streamLimit:limit,excess:count-limit,servers:new Set()});
    overLimit.get(stream.customer_id).servers.add(stream.server_name||'Jellyfin');
  }
  const overLimitCustomers=[...overLimit.values()].map(row=>({...row,servers:[...row.servers]})).sort((a,b)=>b.excess-a.excess||a.customerName.localeCompare(b.customerName));
  const offlineServers=data.servers.filter(server=>server.enabled&&server.health_status==='offline');
  const recentDecisions=data.significantEvents.filter(event=>withinHours(event.created_at,24));
  const stopFailures=recentDecisions.filter(event=>event.decision==='stop_failed');
  const safetyIssues=recentDecisions.filter(event=>event.decision==='skipped_safety'&&SAFETY_ISSUE_REASONS.has(event.reason));
  const violations=recentDecisions.filter(event=>['would_stop','stopped','stop_failed'].includes(event.decision));
  return{overLimitCustomers,offlineServers,recentDecisions,stopFailures,safetyIssues,violations,hasIssues:Boolean(offlineServers.length||stopFailures.length||overLimitCustomers.length||safetyIssues.length)};
}

function playbackHero(data,policy,state){
  const summary=data.summary||{},mode=String(policy.mode||'observe'),modeLabel=mode==='enforce'?'Enforce mode':mode==='warn'?'Warn mode':'Observe mode';
  let tone='streaming',title='Playback is operating normally',next='No playback intervention is required. Change policy only when you intentionally want different concurrency behaviour.',primary='<a class="button secondary" href="#active-streams">Active streams</a>';
  if(state.offlineServers.length){tone='bad';title=`${state.offlineServers.length} Jellyfin ${state.offlineServers.length===1?'server is':'servers are'} offline`;next=`Restore ${state.offlineServers[0].name} before relying on fleet-wide playback or enforcement decisions.`;primary='<a class="button" href="/admin/servers/dashboard">Fix server health</a><a class="button secondary" href="#playback-issues">Playback issues</a>';}
  else if(state.stopFailures.length){tone='bad';title=`${state.stopFailures.length} playback stop ${state.stopFailures.length===1?'attempt failed':'attempts failed'} in the last 24 hours`;next='Review server health and the failed policy decision before relying on automatic enforcement.';primary='<a class="button" href="#policy-decisions">Review failed actions</a><a class="button secondary" href="/admin/servers/dashboard">Server health</a>';}
  else if(state.overLimitCustomers.length){tone='warn';title=`${state.overLimitCustomers.length} ${state.overLimitCustomers.length===1?'customer is':'customers are'} currently above the stream limit`;next=`Review ${state.overLimitCustomers[0].customerName}'s active sessions first. Enforcement still waits for the configured grace period, confirmations and safety revalidation.`;primary='<a class="button" href="#playback-issues">Review affected customers</a><a class="button secondary" href="#active-streams">Active streams</a>';}
  else if(state.safetyIssues.length){tone='warn';title=`${state.safetyIssues.length} enforcement safety ${state.safetyIssues.length===1?'issue needs':'issues need'} review`;next='Review the safety-skip reasons before changing enforcement settings; CAPTAiNFiN deliberately refused an unsafe stop.';primary='<a class="button" href="#policy-decisions">Review safety checks</a><a class="button secondary" href="/admin/servers/dashboard">Server health</a>';}
  else if(state.violations.length){tone='warn';title=`${state.violations.length} stream-limit ${state.violations.length===1?'event was':'events were'} recorded in the last 24 hours`;next='Review recent policy decisions to confirm who exceeded limits and whether the configured mode matches your intent.';primary='<a class="button" href="#policy-decisions">Review policy decisions</a><a class="button secondary" href="#playback-policy">Stream policy</a>';}
  return ui.operatorHero({tone,eyebrow:'Playback control room',title,body:'Live managed playback and concurrency exceptions are shown before policy configuration, fleet detail and historical records.',statusLabel:modeLabel,next,facts:[
    {label:'Active streams',value:String(summary.active_streams||0),detail:`${summary.transcodes||0} transcoding`},
    {label:'Over limit now',value:String(state.overLimitCustomers.length),detail:'customers above current entitlement'},
    {label:'Limit events · 24h',value:String(summary.violations_24h||0),detail:`${summary.stopped_24h||0} stopped · ${summary.stop_failures_24h||0} failed`},
    {label:'Fleet online',value:`${Math.max(0,Number(summary.enabled_servers||0)-Number(summary.offline_servers||0))}/${summary.enabled_servers||0}`,detail:`${summary.safety_issues_24h||0} safety issues · ${summary.safety_skips_24h||0} total skips`}
  ],actionsHtml:`${primary}<a class="button secondary" href="#playback-policy">Policy settings</a>`});
}

function issueCards(state){
  const cards=[];
  if(state.offlineServers.length)cards.push(ui.resolutionCard({tone:'bad',title:`Restore ${state.offlineServers.length} offline Jellyfin ${state.offlineServers.length===1?'server':'servers'}`,body:'Playback observations can be incomplete while an enabled server is offline, so cross-server concurrency decisions are less trustworthy.',reason:'The activity worker relies on a complete fleet snapshot before it can safely enforce stream limits.',actionHtml:'<a class="button" href="/admin/servers/dashboard">Open fleet health</a>',badge:'Playback visibility'}));
  if(state.stopFailures.length)cards.push(ui.resolutionCard({tone:'bad',title:`Investigate ${state.stopFailures.length} failed playback stop ${state.stopFailures.length===1?'attempt':'attempts'}`,body:'Jellyfin did not complete a policy stop request. Playback may still be active even though the concurrency limit was confirmed.',reason:'Automatic enforcement is only useful when the target server accepts the stop request.',actionHtml:'<a class="button" href="#policy-decisions">Review failed actions</a>',secondaryHtml:'<a class="button secondary" href="/admin/servers/dashboard">Check server health</a>',badge:'Enforcement failed'}));
  for(const customer of state.overLimitCustomers.slice(0,8))cards.push(ui.resolutionCard({tone:'warn',title:`${customer.customerName} is using ${customer.streamCount} streams with a limit of ${customer.streamLimit}`,body:`${customer.excess} stream${customer.excess===1?' is':'s are'} currently above entitlement across ${customer.servers.join(', ')}.`,reason:'The live activity snapshot already counts paused sessions according to the configured policy, so this reflects the same concurrency basis the worker uses.',actionHtml:`<a class="button" href="/admin/users/${encodeURIComponent(customer.customerId)}">Open customer</a>`,secondaryHtml:'<a class="button secondary" href="#active-streams">View sessions</a>',badge:'Above stream limit'}));
  if(state.safetyIssues.length)cards.push(ui.resolutionCard({tone:'warn',title:`Review ${state.safetyIssues.length} safety-blocked enforcement ${state.safetyIssues.length===1?'decision':'decisions'}`,body:'CAPTAiNFiN refused to stop playback because it could not prove the action was safe from the current live state.',reason:'Incomplete fleet snapshots, failed revalidation or missing client media-control capability intentionally stop enforcement from guessing.',actionHtml:'<a class="button" href="#policy-decisions">Review safety reasons</a>',secondaryHtml:'<a class="button secondary" href="/admin/servers/dashboard">Check fleet health</a>',badge:'Safety guard'}));
  return cards.join('');
}

function decorateEvent(event){return{...event,decision_label:decisionLabel(event.decision),reason_label:reasonLabel(event.reason),tone:eventTone(event),safety_issue:event.decision==='skipped_safety'&&SAFETY_ISSUE_REASONS.has(event.reason)};}

function createAdminActivityRouter(){
  const router=express.Router();
  router.use('/admin/activity',requireAdminSession,noStore);
  router.get('/admin/activity',async(req,res,next)=>{try{
    await runtimeSettings.ensureLoaded();
    const policy=await streamPolicy.get(),cfg={...activity.config(),countPaused:policy.countPaused},data=await dashboardData(cfg),state=playbackState(data);
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.activity.view','admin_dashboard','activity',$2::jsonb)`,[req.session.authUserId,JSON.stringify({mode:policy.mode})]);
    return res.render('admin/activity',{siteName:runtimeSettings.siteName(),cfg,policy,csrfToken:csrf.token(req),message:req.query.message||null,error:req.query.error||null,heroHtml:playbackHero(data,policy,state),issueHtml:issueCards(state),state,significantEvents:data.significantEvents.map(decorateEvent),recentDecisions:state.recentDecisions.map(decorateEvent),events:data.events.map(decorateEvent),summary:data.summary,streams:data.streams,servers:data.servers,history:data.history});
  }catch(error){return next(error);}});
  router.post('/admin/activity/policy',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await streamPolicy.save(req.body,req.session.authUserId);return res.redirect('/admin/activity?message='+encodeURIComponent('Stream policy saved. The activity worker will pick it up automatically.'));}catch(error){return res.redirect('/admin/activity?error='+encodeURIComponent(error.message));}});
  return router;
}

module.exports={createAdminActivityRouter,requireAdminSession,dashboardData,playbackState,playbackHero,issueCards,reasonLabel,decisionLabel,eventTone,SAFETY_ISSUE_REASONS};
