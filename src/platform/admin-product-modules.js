'use strict';

const express=require('express');
const {query}=require('../db');
const {esc,layout}=require('./admin-html');
const runtimeSettings=require('./runtime-settings');
const stremioRuntime=require('../stremio/runtime-settings');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function number(value){return Number(value||0).toLocaleString('en-GB');}
function metric(label,value,meta='',href=''){const body=`<div class="metricLabel">${esc(label)}</div><div class="metricValue">${esc(number(value))}</div>${meta?`<div class="subText">${esc(meta)}</div>`:''}`;return href?`<a class="metric" href="${esc(href)}" style="text-decoration:none">${body}</a>`:`<div class="metric">${body}</div>`;}
function actions(items){return `<div class="quick-actions">${items.map(item=>`<a class="quick-action" href="${esc(item.href)}"><strong>${esc(item.title)}</strong><span>${esc(item.text)}</span></a>`).join('')}</div>`;}

async function jellyfinData(){
  const result=await query(`SELECT
    (SELECT COUNT(*)::int FROM jellyfin_servers WHERE enabled=TRUE) enabled_servers,
    (SELECT COUNT(*)::int FROM jellyfin_servers WHERE enabled=TRUE AND health_status='offline') offline_servers,
    (SELECT COUNT(*)::int FROM plans WHERE archived_at IS NULL AND active=TRUE AND COALESCE(service_type,'jellyfin') IN ('jellyfin','bundle')) plans,
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
      (SELECT COUNT(*)::int FROM plans WHERE archived_at IS NULL AND active=TRUE AND COALESCE(service_type,'jellyfin') IN ('stremio','bundle')) plans,
      (SELECT COUNT(*)::int FROM stremio_entitlements WHERE status='active') active_entitlements,
      (SELECT COUNT(*)::int FROM stremio_entitlements WHERE last_stream_request_at>=NOW()-INTERVAL '24 hours') active_24h`)
  ]);
  return{...result.rows[0],runtime_enabled:stremioRuntime.enabled(),ready_indexes:checks.readyIndexes,eligible_sources:checks.eligibleSources};
}

async function jellyfinPage(){
  await runtimeSettings.ensureLoaded();const d=await jellyfinData(),attention=Number(d.offline_servers||0)+Number(d.provisioning_attention||0);
  const body=`<div class="metrics">${metric('Active customers',d.customers,'Jellyfin or bundle access','/admin/users?service=jellyfin')}${metric('Servers',d.enabled_servers,`${number(d.offline_servers)} offline`,'/admin/servers')}${metric('Plans',d.plans,'Jellyfin and bundle products','/admin/plans?type=jellyfin')}${metric('Playing now',d.active_streams,'Jellyfin sessions','/admin/activity')}</div>${attention?`<div class="notice warning"><strong>${number(attention)} Jellyfin item${attention===1?'':'s'} need attention.</strong> Review offline servers and provisioning problems before changing commercial settings.</div>`:''}${actions([
    {title:'Servers',text:'Fleet health, credentials, capacity and libraries',href:'/admin/servers'},
    {title:'Plans',text:'Jellyfin product rules, pricing and availability',href:'/admin/plans?type=jellyfin'},
    {title:'Customers',text:'Open the shared customer system filtered to Jellyfin',href:'/admin/users?service=jellyfin'},
    {title:'Playback',text:'Live sessions, transcodes and stream policy',href:'/admin/activity'}
  ])}`;
  return layout({siteName:runtimeSettings.siteName(),active:'jellyfin-overview',title:'Jellyfin',subtitle:'Fleet, products, customers and playback in one product workspace',body});
}

async function stremioPage(){
  await runtimeSettings.ensureLoaded();const d=await stremioData();
  const sourceCount=Number(d.managed_sources||0)+Number(d.external_sources||0);
  const body=`<div class="metrics">${metric('Runtime',d.runtime_enabled?1:0,d.runtime_enabled?'Active':'Paused','/admin/servers/stremio')}${metric('Sources',sourceCount,`${number(d.managed_sources)} managed · ${number(d.external_sources)} external`,'/admin/servers/stremio')}${metric('Plans',d.plans,'Stremio and bundle products','/admin/plans?type=stremio')}${metric('Active customers',d.active_entitlements,`${number(d.active_24h)} searched in 24h`,'/admin/users?service=stremio')}</div><div class="securityNote standalone"><strong>${esc(d.ready_indexes)} ready index${Number(d.ready_indexes)===1?'':'es'} across ${esc(d.eligible_sources)} eligible source${Number(d.eligible_sources)===1?'':'s'}</strong><div class="subText">Managed sources remain primary; external Jellyfin sources complement results independently.</div></div>${actions([
    {title:'Sources',text:'Managed Jellyfin and external fallback sources',href:'/admin/servers/stremio'},
    {title:'Plans',text:'Stremio products, bundles and source assignment',href:'/admin/plans?type=stremio'},
    {title:'Customers',text:'Open the shared customer system filtered to Stremio',href:'/admin/users?service=stremio'},
    {title:'Playback',text:'Managed Stremio account and playback activity',href:'/admin/servers/stremio#activity'}
  ])}`;
  return layout({siteName:runtimeSettings.siteName(),active:'stremio-overview',title:'Stremio',subtitle:'Runtime, sources, products and managed activity in one product workspace',body});
}

const resellerSections={
  '/admin/resellers':{active:'reseller-overview',title:'Resellers',subtitle:'Reserved product module',lead:'The reseller module is intentionally structural for now. Monthly-fee and credit-based reseller models will share this one product area.'},
  '/admin/resellers/resellers':{active:'reseller-accounts',title:'Resellers',subtitle:'Reseller accounts',lead:'Future reseller organisations and account status will live here.'},
  '/admin/resellers/plans':{active:'reseller-plans',title:'Reseller plans',subtitle:'Commercial model',lead:'Future reseller plans can choose a monthly seat allowance or a credit balance without creating separate portal modules.'},
  '/admin/resellers/users':{active:'reseller-users',title:'Reseller users',subtitle:'Allocations',lead:'Future reseller-created Jellyfin users and allocation limits will live here.'},
  '/admin/resellers/servers':{active:'reseller-servers',title:'Reseller servers',subtitle:'Delivery scope',lead:'Future reseller server eligibility and placement rules will live here.'},
  '/admin/resellers/activity':{active:'reseller-activity',title:'Reseller activity',subtitle:'Operational history',lead:'Future reseller provisioning and usage events will live here.'}
};
function resellerPage(path){const page=resellerSections[path]||resellerSections['/admin/resellers'];const body=`<div class="notice"><strong>Reserved for later development.</strong> ${esc(page.lead)}</div>${actions([
  {title:'Shared Customers',text:'Customer identity stays global rather than duplicated per module',href:'/admin/users'},
  {title:'Shared Commerce',text:'Orders and payments remain authoritative in one place',href:'/admin/commerce'},
  {title:'Jellyfin',text:'Current managed-server product workspace',href:'/admin/jellyfin'},
  {title:'Stremio',text:'Current stream-source product workspace',href:'/admin/stremio'}
])}`;return layout({siteName:runtimeSettings.siteName(),active:page.active,title:page.title,subtitle:page.subtitle,body});}

function createAdminProductModulesRouter(){
  const router=express.Router();router.use('/admin',gate,noStore);
  router.get('/admin/jellyfin',async(_req,res,next)=>{try{return res.send(await jellyfinPage());}catch(error){return next(error);}});
  router.get('/admin/stremio',async(_req,res,next)=>{try{return res.send(await stremioPage());}catch(error){return next(error);}});
  for(const path of Object.keys(resellerSections))router.get(path,async(_req,res,next)=>{try{await runtimeSettings.ensureLoaded();return res.send(resellerPage(path));}catch(error){return next(error);}});
  return router;
}

module.exports={createAdminProductModulesRouter,jellyfinData,stremioData,resellerSections};
