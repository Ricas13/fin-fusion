'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const nav=require('../src/platform/admin-nav');
const dashboard=fs.readFileSync(path.join(__dirname,'..','src','platform','admin-dashboard-view-v2.js'),'utf8');
const backupTabs=fs.readFileSync(path.join(__dirname,'..','src','platform','backup-workflow-tabs.js'),'utf8');
const settings=fs.readFileSync(path.join(__dirname,'..','src','platform','admin-original-settings.js'),'utf8');

const pageKeys=Object.fromEntries(nav.groups.map(group=>[group.key,group.pages.map(page=>page[0])]));
assert.deepStrictEqual(pageKeys.dashboard,['dashboard','attention'],'Dashboard should contain current-state/action destinations only');
assert(nav.hiddenPages.search?.parentKey==='dashboard','Search results must remain routable under Dashboard without consuming a sidebar destination');
assert.deepStrictEqual(pageKeys.automation,['provisioning','automation-jobs','events'],'Automation should expose the operational workflow, jobs, and audit history without implementation-detail duplicates');
assert(!pageKeys.settings.includes('settings-commerce'),'Commerce must not be duplicated under Settings');
assert(!pageKeys.settings.includes('settings-advanced'),'A vague Advanced link hub must not consume a Settings sidebar slot');
assert(pageKeys.settings.includes('backups'),'Backups & Transfer must remain discoverable in Settings');
assert(nav.hiddenPages['policy-drift']&&nav.hiddenPages['notification-gateway']&&nav.hiddenPages['configuration-transfer'],'Diagnostic/detail workflow pages must stay routable without consuming sidebar space');
assert(backupTabs.includes("['backups','Database backups','/admin/backups']")&&backupTabs.includes("['transfer','Configuration transfer','/admin/configuration']"),'Backup and portable configuration must share one stable workflow');
assert(settings.includes("requested==='advanced')return res.redirect('/admin/configuration')"),'Legacy Settings Advanced URLs must resolve to Configuration Transfer');
assert(settings.includes("requested==='commerce')return res.redirect('/admin/commerce')"),'Legacy Settings Commerce URLs must resolve to the real Commerce area');
assert(!settings.includes('Recent customers on dashboard')&&!settings.includes('Expiring-soon window'),'Retired dashboard settings must not remain visible controls');
assert(dashboard.includes('businessPerformanceGrid')&&dashboard.includes('streamingOperationsGrid')&&dashboard.includes('commerceAnalyticsGrid'),'Dashboard sections must remain explicit for browser layout checks');
assert(!dashboard.includes("customerGrowth(s){return card('Customer base over time','Cumulative CAPTAiNFiN customer accounts',areaChart(s.customerGrowth,'total'),{className:'wide'"),'Business performance must not pair two 8/12 cards and leave empty columns');
assert(dashboard.includes("return card('Top referrers'" )&&dashboard.includes("{className:'wide'}"),'Commerce second row needs an 8/12 companion for Product usage');
console.log('admin product audit smoke: ok');
