'use strict';

const assert=require('assert');
const nav=require('../src/platform/admin-nav');
const dashboard=require('fs').readFileSync(require('path').join(__dirname,'..','src','platform','admin-dashboard-view-v2.js'),'utf8');

const pageKeys=Object.fromEntries(nav.groups.map(group=>[group.key,group.pages.map(page=>page[0])]));
assert.deepStrictEqual(pageKeys.dashboard,['dashboard','attention','search'],'Dashboard should contain current-state/action destinations only');
assert.deepStrictEqual(pageKeys.automation,['provisioning','automation-jobs','events'],'Automation should expose the operational workflow, jobs, and audit history without implementation-detail duplicates');
assert(!pageKeys.settings.includes('settings-commerce'),'Commerce must not be duplicated under Settings');
assert(nav.hiddenPages['policy-drift']&&nav.hiddenPages['notification-gateway'],'Diagnostic subpages must stay routable without consuming sidebar space');
assert(dashboard.includes('businessPerformanceGrid')&&dashboard.includes('streamingOperationsGrid')&&dashboard.includes('commerceAnalyticsGrid'),'Dashboard sections must remain explicit for browser layout checks');
assert(!dashboard.includes("customerGrowth(s){return card('Customer base over time','Cumulative CAPTaINFiN customer accounts',areaChart(s.customerGrowth,'total'),{className:'wide'"),'Business performance must not pair two 8/12 cards and leave empty columns');
assert(dashboard.includes("return card('Top referrers'" )&&dashboard.includes("{className:'wide'}"),'Commerce second row needs an 8/12 companion for Product usage');
console.log('admin product audit smoke: ok');
