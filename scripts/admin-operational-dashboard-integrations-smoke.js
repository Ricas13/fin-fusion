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
assert(dashboardDataSource.includes('items: sources.slice(0, 5)'),'Dashboard must cap the fixed exception summary while preserving the total count');
assert(dashboardSource.includes('${dashboardHero(ctx)}${attentionOverview(stats)}${setupCompact(stats)}${rangeControls(ctx.range)}'),'Operator control room and Needs Attention must render before setup nudges and routine analytics controls');
assert(!dashboardSource.includes('function operationalAlerts'),'Legacy duplicate operational alert counters must not remain as a second dashboard exception model');

const clear=dashboard.attentionOverview({attention:{count:0,items:[]}});
assert(clear.includes('No operational issues need attention')&&clear.includes('/admin/attention')&&clear.includes('Open operational inbox'),'Clear dashboard state must explain that no exceptions are open and retain the canonical workspace link');
const problems=dashboard.attentionOverview({attention:{count:2,items:[{key:'provisioning:1',title:'Provisioning failed',detail:'Customer access was not created',area:'Customers',severity:'critical',href:'/admin/users/1'},{key:'backup:2',title:'Backup verification missing',detail:'Restore verification missing',area:'Backups',severity:'warning',href:'/admin/backups'}]}});
assert(problems.includes('2 things need attention')&&problems.includes('Provisioning failed')&&problems.includes('Backup verification missing'),'Dashboard must surface real canonical attention items rather than generic counters');
assert(problems.includes('Fix provisioning')&&problems.includes('Fix backup'),'Dashboard must label exception links with the actual corrective intent');

assert(cardSource.includes('Enabled')&&cardSource.includes('Configured')&&cardSource.includes('Current state')&&cardSource.includes('Last verified'),'Shared integration cards must answer the standard operator health questions');
const rendered=cards.renderIntegrationCard({name:'Example',statusLabel:'Connected',statusKind:'good',enabled:true,configured:true,workingLabel:'Delivery observed',workingKind:'good',lastVerifiedAt:'2026-08-21T20:00:00Z',fixHint:'Retest the connection.',actionsHtml:'<a href="#manage">Manage</a>'});
assert(rendered.includes('integrationCard')&&rendered.includes('Connected')&&rendered.includes('Delivery observed')&&rendered.includes('Retest the connection.')&&rendered.includes('Manage'),'Shared integration card renderer must carry status, evidence, recovery guidance and actions');
assert(cardCss.includes('.integrationCardGrid')&&cardCss.includes('.attentionOverview'),'Shared integration and dashboard exception styles must live outside individual page templates');

assert(paymentSource.includes("require('./admin-integration-card')"),'Payments must use the shared integration-card renderer');
assert(paymentSource.includes("providerHealthCard(req,'stripe'")&&paymentSource.includes("providerHealthCard(req,'paypal'"),'Stripe and PayPal must use the same provider health-card path');
assert(paymentSource.includes("providerEvents=(events||[]).filter(event=>event.provider===provider)"),'Payment working state must be derived from existing provider events');
assert(paymentSource.includes("latestSuccessful=providerEvents.find(event=>!event.failed&&event.processed_at)"),'Payment last verification must use a successfully processed provider event');
assert(paymentSource.includes('Test connection')&&paymentSource.includes('>Manage</a>'),'Payment cards must provide test and manage actions');
assert(!paymentSource.includes('function providerMetric'),'Old provider-specific metric cards must not remain alongside the shared integration cards');

assert(emailSource.includes("require('./admin-integration-card')"),'Email must use the shared integration-card renderer');
assert(emailSource.includes("(recent || []).find(row => row.status === 'sent')"),'Email last verification must use an observed successful delivery');
assert(emailSource.includes('Test connection')&&emailSource.includes('href="#email-gateway">Manage</a>'),'Email card must provide test and manage actions');
assert(emailSource.includes("statusLabel = 'Needs attention'")&&emailSource.includes('failed message'),'Email card must surface queued delivery failures as an operational warning');

assert(formFeedbackSource.includes("if (form.dataset.nativeSubmit === 'true') return false;"),'Admin AJAX form enhancement must preserve native-submit escape hatches for browser-owned redirects');
assert(personalNotificationsSource.includes('action="/admin/profile/notifications/telegram/start" data-native-submit="true"'),'Telegram account linking must use a native browser submission so the t.me redirect is not followed by fetch/CORS');
assert(personalNotificationsSource.includes('action="/admin/profile/notifications/discord/start" data-native-submit="true"'),'Discord OAuth linking must use a native browser submission so the discord.com redirect is not followed by fetch/CORS');

console.log('operational dashboard and integration cards smoke: ok');