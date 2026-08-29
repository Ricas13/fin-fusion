'use strict';

const express=require('express');
const {query}=require('../db');
const csrf=require('../auth/csrf');
const {esc,layout}=require('./admin-html');
const runtimeSettings=require('./runtime-settings');
const stremioRuntime=require('../stremio/runtime-settings');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function number(value){return Number(value||0).toLocaleString('en-GB');}
function date(value){if(!value)return'Never';const d=new Date(value);return Number.isNaN(d.getTime())?'—':d.toLocaleString('en-GB');}
function metric(label,value,meta='',href=''){const body=`<div class="metricLabel">${esc(label)}</div><div class="metricValue">${esc(number(value))}</div>${meta?`<div class="subText">${esc(meta)}</div>`:''}`;return href?`<a class="metric" href="${esc(href)}" style="text-decoration:none">${body}</a>`:`<div class="metric">${body}</div>`;}
function csrfInput(token){return `<input type="hidden" name="_csrf" value="${esc(token)}">`;}
function leaseResetAction(row,token){if(!row.customer_id)return'<span class="muted">No customer link</span>';return `<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(row.customer_id)}/stremio-household/reset">${csrfInput(token)}<button class="button secondary btn-sm" type="submit">Reset lease</button></form>`;}

async function jellyfinData(){
  const result=await query(`SELECT
    (SELECT COUNT(*)::int FROM jellyfin_servers WHERE enabled=TRUE) enabled_servers,
    (SELECT COUNT(*)::int FROM jellyfin_servers WHERE enabled=TRUE AND health_status='offline') offline_servers,
    (SELECT COUNT(*)::int FROM plans WHERE archived_at IS NULL AND active=TRUE AND COALESCE(service_type,'jellyfin')='jellyfin') plans,
    (SELECT COUNT(DISTINCT s.customer_id)::int FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.superseded_by IS NULL AND s.current_period_end>NOW() AND s.status IN('active','trialing','past_due','paused') AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('jellyfin','bundle')) customers,
    (SELECT COUNT(*)::int FROM active_playback_sessions) active_streams,
    (SELECT COUNT(*)::int FROM customer_provisioning_state WHERE status IN ('blocked','failed')) provisioning_attention`);
  return result.rows[0]||{};
}

async function stremioData(){
  await stremioRuntime.ensureLoaded();
  const [checks,result]=await Promise.all([
    stremioRuntime.prerequisites(),
    query(`SELECT
      (SELECT COUNT(*)::int FROM jellyfin_servers WHERE enabled=TRUE AND stremio_enabled=TRUE) managed_sources,
      (SELECT COUNT(*)::int FROM stremio_sources WHERE enabled=TRUE AND auth_state='connected') external_sources,
      (SELECT COUNT(*)::int FROM plans WHERE archived_at IS NULL AND active=TRUE AND COALESCE(service_type,'jellyfin')='stremio' AND COALESCE(is_addon,FALSE)=FALSE) plans,
      (SELECT COUNT(*)::int FROM stremio_entitlements WHERE status='active') active_entitlements,
      (SELECT COUNT(*)::int FROM stremio_entitlements WHERE last_stream_request_at>=NOW()-INTERVAL '24 hours') active_24h`)
  ]);
  return{...result.rows[0],runtime_enabled:stremioRuntime.enabled(),ready_indexes:checks.readyIndexes,eligible_sources:checks.eligibleSources};
}

async function stremioPlaybackData(){
  const [summary,recent,leases]=await Promise.all([
    query(`SELECT
      COUNT(*)::int managed_accounts,
      COUNT(*) FILTER(WHERE status='active')::int active_accounts,
      COUNT(*) FILTER(WHERE last_playback_info_at>=NOW()-INTERVAL '24 hours')::int playback_24h,
      COUNT(*) FILTER(WHERE status='error' OR last_error IS NOT NULL)::int attention
      FROM stremio_managed_accounts`),
    query(`SELECT sma.customer_id,sma.status,sma.last_playback_info_at,sma.last_error,sma.updated_at,
      COALESCE(c.display_name,u.username,c.email,'Customer') customer_name,c.email customer_email,
      js.name server_name,ja.jellyfin_username hidden_username
      FROM stremio_managed_accounts sma
      JOIN customers c ON c.id=sma.customer_id
      LEFT JOIN app_users u ON u.id=c.user_id
      JOIN jellyfin_servers js ON js.id=sma.server_id
      JOIN jellyfin_accounts ja ON ja.id=sma.jellyfin_account_id
      ORDER BY COALESCE(sma.last_playback_info_at,sma.updated_at) DESC LIMIT 50`),
    query(`SELECT l.subject_key,l.network_hash,l.network_family,l.first_seen_at,l.last_seen_at,l.expires_at,
      se.id entitlement_id,se.customer_id,COALESCE(c.display_name,u.username,c.email,'Customer') customer_name,c.email customer_email,
      p.name plan_name,p.code plan_code
      FROM access_network_leases l
      LEFT JOIN stremio_entitlements se ON l.subject_key IN (se.id::text,se.subscription_id::text)
      LEFT JOIN customers c ON c.id=se.customer_id
      LEFT JOIN app_users u ON u.id=c.user_id
      LEFT JOIN subscriptions sub ON sub.id=se.subscription_id
      LEFT JOIN plans p ON p.id=sub.plan_id
      WHERE l.scope='stremio' AND l.expires_at>NOW()
      ORDER BY l.last_seen_at DESC,l.expires_at DESC LIMIT 100`)
  ]);
  return{summary:summary.rows[0]||{},recent:recent.rows,leases:leases.rows};
}

async function stremioPlaybackPage(req){
  await runtimeSettings.ensureLoaded();
  const d=await stremioPlaybackData(),s=d.summary,resetToken=csrf.token(req);
  const rows=d.recent.length?`<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Customer</th><th>Hidden user</th><th>Server</th><th>State</th><th>Last managed playback</th></tr></thead><tbody>${d.recent.map(row=>`<tr><td><a href="/admin/users/${esc(row.customer_id)}"><strong>${esc(row.customer_name)}</strong></a><div class="subText">${esc(row.customer_email||'')}</div></td><td>${esc(row.hidden_username||'—')}</td><td>${esc(row.server_name)}</td><td><span class="pill ${row.status==='active'&&!row.last_error?'good':row.status==='error'?'bad':'warn'}">${esc(row.status)}</span>${row.last_error?`<div class="subText">${esc(row.last_error)}</div>`:''}</td><td>${esc(date(row.last_playback_info_at||row.updated_at))}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No managed Stremio accounts have been created yet.</div>';
  const leaseRows=d.leases.length?`<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Customer</th><th>Plan</th><th>IP family</th><th>Network fingerprint</th><th>Leased</th><th>Expires</th><th>Actions</th></tr></thead><tbody>${d.leases.map(row=>`<tr><td>${row.customer_id?`<a href="/admin/users/${esc(row.customer_id)}"><strong>${esc(row.customer_name)}</strong></a>`:`<strong>${esc(row.customer_name||'Unknown entitlement')}</strong>`}<div class="subText">${esc(row.customer_email||row.subject_key||'')}</div></td><td>${esc(row.plan_name||'Unknown plan')}<div class="subText">${esc(row.plan_code||'')}</div></td><td><span class="pill accent">${esc(String(row.network_family||'unknown').toUpperCase())}</span></td><td><code>${esc(String(row.network_hash||'').slice(0,12))}...</code><div class="subText">Plain IP addresses are not stored.</div></td><td>${esc(date(row.last_seen_at||row.first_seen_at))}</td><td>${esc(date(row.expires_at))}</td><td>${leaseResetAction(row,resetToken)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No active Stremio household IP leases right now.</div>';
  const body=`<div class="metrics">${metric('Active IP leases',d.leases.length,'Current IPv4/IPv6 household windows')}${metric('Managed accounts',s.managed_accounts,'Hidden Jellyfin identities')}${metric('Active',s.active_accounts,'Ready managed mappings')}${metric('Used in 24h',s.playback_24h,'Managed PlaybackInfo activity')}${metric('Needs attention',s.attention,'Mappings with an error','/admin/servers/stremio')}</div><div class="securityNote standalone"><strong>External playback is intentionally not tracked here.</strong><div class="subText">External Stremio results go directly from the customer to the external Jellyfin server, so CAPTAiNFiN never sees or proxies those media bytes. Household lease timing is tracked without plaintext IP storage.</div></div><section class="section"><div class="sectionHead"><h2>Current household IP leases</h2><a class="button secondary btn-sm" href="/admin/users?service=stremio">Open Stremio customers</a></div>${leaseRows}</section><section class="section"><div class="sectionHead"><h2>Recent managed playback</h2><a class="button secondary btn-sm" href="/admin/servers/stremio#activity">Open source activity</a></div>${rows}</section>`;
  return layout({siteName:runtimeSettings.siteName(),active:'stremio-playback',title:'Stremio household leases',subtitle:'Current user/IP lease windows and managed playback health',body});
}

function createAdminProductModulesRouter(){
  const router=express.Router();
  router.use('/admin',gate,noStore);
  router.get('/admin/jellyfin',(_req,res)=>res.redirect('/admin/servers'));
  router.get('/admin/stremio',(_req,res)=>res.redirect('/admin/servers/stremio'));
  router.get('/admin/stremio/playback',async(req,res,next)=>{try{return res.send(await stremioPlaybackPage(req));}catch(error){return next(error);}});
  return router;
}

module.exports={createAdminProductModulesRouter,jellyfinData,stremioData,stremioPlaybackData};
