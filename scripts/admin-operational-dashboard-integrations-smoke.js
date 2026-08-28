'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const dashboardSource=read('src/platform/admin-dashboard.js');
const dashboardDataSource=read('src/platform/admin-dashboard-data.js');
const paymentSource=read('src/platform/admin-payment-settings.js');
const emailSource=read('src/platform/admin-email.js');
const cardSource=read('src/platform/admin-integration-card.js');
const cardCss=read('public/css/admin-integration-cards.css');
const personalNotificationsSource=read('src/platform/admin-personal-notification-preferences-v2.js');
const formFeedbackSource=read('public/js/admin-form-feedback.js');
const dashboard=require('../src/platform/admin-dashboard');
const cards=require('../src/platform/admin-integration-card');

assert(dashboardDataSource.includes('attention.list().catch(() => [])'),'Dashboard must read the canonical Needs Attention list instead of recreating operational queries');
assert(!dashboardDataSource.includes('attention.openSummary().catch'),'Dashboard must not query the same attention source once for summary and again for detail');
assert(dashboardDataSource.includes('items: sources.slice(0, 5)'),'Dashboard must cap attention detail while preserving the total count');
assert(dashboardSource.includes('${dashboardHero(ctx)}${rangeControls(ctx.range)}${html}'),'Profit/streams/attention hero must render before the three dashboard analytics widgets');
assert(!dashboardSource.includes('function attentionOverview')&&!dashboardSource.includes('setupCompact'),'Home must not reintroduce separate Needs Attention or setup tiles outside the target hero + three-widget layout');
assert(!dashboardSource.includes('function operationalAlerts'),'Legacy duplicate operational alert counters must not remain as a second dashboard exception model');

const clear=dashboard.dashboardHero({reporting:{currency:'GBP'},data:{profitability:{currency:'GBP',current:{profitMinor:10000},previous:{profitMinor:5000},ytd:{profitMinor:30000}},streamGauge:{active:2,capacity:10},attention:{count:0}}});
assert(clear.includes('Profit this month')&&clear.includes('Profit YTD')&&clear.includes('Live streams')&&clear.includes('Needs attention'),'Dashboard hero must expose exactly the four requested business/operational signals');
assert(clear.includes('2 / 10')&&clear.includes('used / sellable stream capacity'),'Dashboard hero must show the live-stream gauge against sellable capacity');
assert(clear.includes('No current intervention required')&&clear.includes('/admin/attention'),'Clear attention state must remain linked to the canonical operational inbox');
const problems=dashboard.dashboardHero({reporting:{currency:'GBP'},data:{profitability:{currency:'GBP',current:{profitMinor:-1000},previous:{profitMinor:500},ytd:{profitMinor:2000}},streamGauge:{active:4,capacity:8},attention:{count:2}}});
assert(problems.includes('profitHeroCard bad')&&problems.includes('2 current issues require review'),'Negative profit and non-zero attention must use meaningful danger styling/copy in the hero');

assert(cardSource.includes('Enabled')&&cardSource.includes('Configured')&&cardSource.includes('Current state')&&cardSource.includes('Last verified'),'Shared integration cards must answer the standard operator health questions');
assert(cardSource.includes('detailsHtml'),'Shared integration cards must support optional inline configuration without changing existing callers');
const rendered=cards.renderIntegrationCard({name:'Example',statusLabel:'Connected',statusKind:'good',enabled:true,configured:true,workingLabel:'Delivery observed',workingKind:'good',lastVerifiedAt:'2026-08-21T20:00:00Z',fixHint:'Retest the connection.',actionsHtml:'<a href="#manage">Manage</a>',detailsHtml:'<details class="integrationConfig"><summary>Configure</summary></details>'});
assert(rendered.includes('integrationCard')&&rendered.includes('Connected')&&rendered.includes('Delivery observed')&&rendered.includes('Retest the connection.')&&rendered.includes('Manage')&&rendered.includes('integrationConfig'),'Shared integration card renderer must carry status, evidence, recovery guidance, actions and optional inline detail');
assert(cardCss.includes('.integrationCardGrid')&&cardCss.includes('.integrationDetails')&&cardCss.includes('.integrationConfig'),'Shared integration styles must live outside individual page templates');

assert(paymentSource.includes("require('./admin-integration-card')"),'Payments must use the shared integration-card renderer');
for(const provider of ['stripe','paypal','plisio'])assert(paymentSource.includes(`providerHealthCard(req,'${provider}'`),`${provider} must use the same provider health-card path`);
assert(paymentSource.includes("providerEvents=(events||[]).filter(event=>event.provider===provider)"),'Payment working state must be derived from existing provider events');
assert(paymentSource.includes("latestSuccessful=providerEvents.find(event=>!event.failed&&event.processed_at)"),'Payment last verification must use a successfully processed provider event');
assert(paymentSource.includes('Test connection')&&paymentSource.includes('Configure ${esc(label)}'),'Payment cards must provide test and inline configure actions');
assert(paymentSource.includes('payment-provider-config'),'Payment provider configuration details must share an exclusive native details group so only one provider is expanded at a time');
assert(paymentSource.includes('detailsHtml:providerConfigDetails(req,provider,status,url)'),'Provider credentials and callback/webhook setup must render inside the matching health card');
assert(!paymentSource.includes("title:'Stripe, PayPal & Plisio credentials'"),'The duplicate lower combined credentials disclosure must not remain');
assert(!paymentSource.includes('function providerMetric'),'Old provider-specific metric cards must not remain alongside the shared integration cards');

assert(emailSource.includes("require('./admin-integration-card')"),'Email must use the shared integration-card renderer');
assert(emailSource.includes("(recent || []).find(row => row.status === 'sent')"),'Email last verification must use an observed successful delivery');
assert(emailSource.includes('Test connection')&&emailSource.includes('href="#email-gateway">Manage</a>'),'Email card must provide test and manage actions');
assert(emailSource.includes("statusLabel = 'Needs attention'")&&emailSource.includes('failed message'),'Email card must surface queued delivery failures as an operational warning on the dedicated delivery page');

assert(formFeedbackSource.includes("if (form.dataset.nativeSubmit === 'true') return false;"),'Admin AJAX form enhancement must preserve native-submit escape hatches for browser-owned redirects');
assert(personalNotificationsSource.includes('action="/admin/profile/notifications/telegram/start" data-native-submit="true"'),'Telegram account linking must use a native browser submission so the t.me redirect is not followed by fetch/CORS');
assert(personalNotificationsSource.includes('action="/admin/profile/notifications/discord/start" data-native-submit="true"'),'Discord OAuth linking must use a native browser submission so the discord.com redirect is not followed by fetch/CORS');

console.log('operational dashboard and integration cards smoke: ok');
require('./admin-integrations-inline-management-smoke');
