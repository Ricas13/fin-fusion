'use strict';

const express=require('express');
const providerSettings=require('../payments/provider-settings');
const requestServiceSettings=require('../integrations/request-service-settings');
const emailSettings=require('../integrations/email-settings');
const notificationSettings=require('../integrations/notification-settings');
const runtimeSettings=require('./runtime-settings');
const connectionsWorkflow=require('./integration-workflow-tabs');
const inline=require('./admin-integrations-inline');
const ui=require('./admin-ui');
const {esc,layout}=require('./admin-html');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
async function integrationState(){await Promise.all([runtimeSettings.ensureLoaded(),providerSettings.ensureLoaded(),requestServiceSettings.ensureLoaded()]);const [stripe,paypal,plisio,requests,email,notifications]=await Promise.all([providerSettings.status('stripe'),providerSettings.status('paypal'),providerSettings.status('plisio'),requestServiceSettings.status(),emailSettings.status().catch(()=>({configured:false,enabled:false})),notificationSettings.status().catch(()=>({telegramEnabled:false,telegramConfigured:false,discordEnabled:false,discordConfigured:false}))]);return{stripe,paypal,plisio,requests,email,notifications};}
function providerReady(status){return Boolean(status?.credentialsConfigured&&status?.webhookConfigured);}
function item(key,name,{enabled=false,configured=false,core=false,href,detail}){const issue=Boolean(enabled&&!configured);return{key,name,enabled:Boolean(enabled),configured:Boolean(configured),core,href,detail,issue};}
function catalogue(state){const n=state.notifications||{};return[
 item('stripe','Stripe',{enabled:state.stripe?.enabled,configured:providerReady(state.stripe),core:true,href:'/admin/payments',detail:'Checkout, renewals and verified payment events'}),
 item('paypal','PayPal',{enabled:state.paypal?.enabled,configured:providerReady(state.paypal),core:true,href:'/admin/payments',detail:'Checkout, renewals and verified payment events'}),
 item('plisio','Plisio',{enabled:state.plisio?.enabled,configured:providerReady(state.plisio),core:true,href:'/admin/payments',detail:'One-time crypto checkout and signed callback verification'}),
 item('email','Transactional email',{enabled:state.email?.enabled,configured:state.email?.configured,core:true,href:'/admin/notifications',detail:'Activation, password reset and support replies'}),
 item('requests','Request service',{enabled:state.requests?.enabled,configured:state.requests?.configured,href:'/admin/request-users',detail:'Optional Overseerr / Jellyseerr / Seerr account sync'}),
 item('telegram','Telegram',{enabled:n.telegramEnabled,configured:n.telegramConfigured,href:'/admin/notifications/preferences',detail:'Optional notification delivery'}),
 item('discord','Discord',{enabled:n.discordEnabled,configured:n.discordConfigured,href:'/admin/notifications/preferences',detail:'Optional notification delivery'})
 ];}
function statePill(row){if(row.issue)return'<span class="integrationOverviewStatus bad"><span aria-hidden="true">!</span>Needs setup</span>';if(row.enabled&&row.configured)return'<span class="integrationOverviewStatus good"><span aria-hidden="true">✓</span>Ready</span>';return'<span class="integrationOverviewStatus"><span aria-hidden="true">○</span>Disabled</span>';}
function rowTarget(row){return row.core?`#integration-${row.key}`:row.href;}
function integrationRow(row){return `<div class="compact-item integrationHealthRow"><div><div class="compact-title">${esc(row.name)}</div><div class="compact-meta">${esc(row.detail)}</div></div><div class="buttonRow">${statePill(row)}<a class="button secondary btn-sm" href="${esc(rowTarget(row))}">${row.issue?'Fix':'Manage'}</a></div></div>`;}
function integrationCard(row,managerHtml=''){return `<article class="settings-card integrationOverviewCard ${row.core?'integrationOverviewCoreCard':''}"><div class="integrationOverviewCardTop"><div class="integrationOverviewIdentity"><div class="compact-title">${esc(row.name)}</div><div class="compact-meta">${esc(row.detail)}</div></div><div class="integrationOverviewCardActions">${statePill(row)}${managerHtml?managerHtml:`<a class="button secondary btn-sm" href="${esc(row.href)}">${row.issue?'Fix setup':'Manage'}</a>`}</div></div></article>`;}
function integrationGrid(rows,managers={}){return `<div class="integrationOverviewGrid ${rows.some(row=>row.core)?'integrationOverviewCoreGrid':'integrationOverviewOptionalGrid'}">${rows.map(row=>integrationCard(row,managers[row.key]||'')).join('')}</div>`;}
function integrationsHero(rows){const issues=rows.filter(row=>row.issue),coreIssues=issues.filter(row=>row.core),ready=rows.filter(row=>row.enabled&&row.configured),first=coreIssues[0]||issues[0];return ui.operatorHero({tone:coreIssues.length?'bad':issues.length?'warn':'good',eyebrow:'Integration control room',title:first?`${issues.length} enabled ${issues.length===1?'integration needs':'integrations need'} setup`:'Enabled integrations are ready',body:'Only enabled-but-incomplete services are treated as problems. Disabled optional integrations are not failures.',statusLabel:first?'Setup required':'Integrations healthy',next:first?`Finish ${first.name} configuration before relying on that workflow.`:'No integration repair is required. Enable optional services only when you intend to use them.',facts:[{label:'Needs setup',value:String(issues.length),detail:'enabled but incomplete'},{label:'Core issues',value:String(coreIssues.length),detail:'payments or transactional email'},{label:'Ready',value:String(ready.length),detail:'enabled and configured'},{label:'Optional off',value:String(rows.filter(row=>!row.enabled&&!row.core).length),detail:'intentionally disabled'}],actionsHtml:first?`<a class="button" href="${esc(rowTarget(first))}">Fix ${esc(first.name)}</a><a class="button secondary" href="#integration-health">Integration health</a>`:'<a class="button secondary" href="#integration-health">Integration health</a>'});}
function connectionsCards(){return connectionsWorkflow.tabs('connections');}
async function page(req){
 await runtimeSettings.ensureLoaded();
 const state=await integrationState(),rows=catalogue(state),issues=rows.filter(row=>row.issue),core=rows.filter(row=>row.core),optional=rows.filter(row=>!row.core),urls=await inline.webhookUrls(req);
 const managers=Object.fromEntries(core.map(row=>[row.key,inline.manager(req,row,state,urls)]));
 const issueSection=issues.length?`<section class="section" id="integration-health">${ui.sectionHeader({title:'Fix enabled integrations first',description:'These services are switched on but are not ready to perform their configured job.'})}<div class="card-body integrationHealthRows">${issues.map(integrationRow).join('')}</div></section>`:`<section class="section" id="integration-health">${ui.sectionHeader({title:'Integration health',description:'No enabled integration is incomplete.'})}<div class="card-body"><div class="emptyCompact">Nothing needs repair.</div></div></section>`;
 const checkoutSummary=inline.paymentProviderSummary(core);
 const coreSection=`<section class="section integrationOverviewSection">${ui.sectionHeader({title:'Core customer services',description:'Payment providers and transactional email are the integrations most likely to affect customer access.'})}<div class="integrationOverviewCheckoutSummary">${esc(checkoutSummary)}</div><div class="card-body integrationOverviewBody">${integrationGrid(core,managers)}</div></section>`;
 const optionalReady=optional.filter(row=>row.enabled&&row.configured).length,optionalEnabled=optional.filter(row=>row.enabled).length;
 const optionalSection=ui.detailDisclosure({title:'Optional integrations',summary:`${optionalReady} configured / ${optional.length} available · ${optionalEnabled} enabled · disabled services are intentionally quiet`,bodyHtml:integrationGrid(optional)});
 const body=`${ui.noticesFromRequest(req)}${integrationsHero(rows)}${issueSection}${coreSection}${optionalSection}`;
 return layout({siteName:runtimeSettings.siteName(),active:'settings-integrations',title:'Connections',subtitle:'External-service readiness, messaging and customer integration entry points',body});
}
function createAdminIntegrationsOverviewRouter(){const router=express.Router();router.use('/admin/settings/integrations',gate,noStore);inline.registerRoutes(router);router.get('/admin/settings/integrations',async(req,res,next)=>{try{return res.send(await page(req))}catch(error){next(error)}});return router;}
module.exports={createAdminIntegrationsOverviewRouter,integrationState,providerReady,catalogue,integrationsHero,connectionsCards,integrationRow,integrationCard,integrationGrid,statePill,page};
