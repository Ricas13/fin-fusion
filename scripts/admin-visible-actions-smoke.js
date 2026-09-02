'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const root=path.join(__dirname,'..');
const platformDir=path.join(root,'src','platform');
const publicFeedback=fs.readFileSync(path.join(root,'public','js','admin-form-feedback.js'),'utf8');
const navSource=fs.readFileSync(path.join(platformDir,'admin-nav.js'),'utf8');
const navModel=require('../src/platform/admin-nav');
const htmlCore=require('../src/platform/admin-html-core');
const tabs=fs.readFileSync(path.join(platformDir,'notification-workflow-tabs.js'),'utf8');
const connectionsTabs=fs.readFileSync(path.join(platformDir,'integration-workflow-tabs.js'),'utf8');
const connectionsWorkflow=require('../src/platform/integration-workflow-tabs');
const notificationWorkflow=require('../src/platform/notification-workflow-tabs');
const provisioningTabs=fs.readFileSync(path.join(platformDir,'provisioning-workflow-tabs.js'),'utf8');
const html=fs.readFileSync(path.join(platformDir,'admin-html.js'),'utf8');
const customerDeletion=fs.readFileSync(path.join(platformDir,'customer-deletion.js'),'utf8');
const customerDeletionFinalizer=fs.readFileSync(path.join(root,'db','migrations','100_customer_deletion_saga.sql'),'utf8');

function jsFiles(dir){
  return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())return jsFiles(full);
    return entry.isFile()&&entry.name.endsWith('.js')?[full]:[];
  });
}

function canonicalSegments(value){
  const clean=String(value||'').split('?')[0];
  return clean.split('/').filter(Boolean).map(segment=>segment.startsWith(':')?':':segment);
}
function sameShape(a,b){const x=canonicalSegments(a),y=canonicalSegments(b);if(x.length!==y.length)return false;return x.every((segment,index)=>segment===':'||y[index]===':'||segment===y[index]);}
function attr(tag,name){const match=tag.match(new RegExp(`${name}=\\\\?['\"]([^'\"\\\\]+)\\\\?['\"]`,'i'));return match?match[1]:'';}

const files=jsFiles(platformDir),sources=files.map(file=>({file,source:fs.readFileSync(file,'utf8')})),routes=[];
for(const {file,source} of sources){const routeRe=/\.(post|all)\(\s*['"`]([^'"`]+)['"`]/g;let match;while((match=routeRe.exec(source)))routes.push({method:match[1],path:match[2],file});}
const actions=[];
for(const {file,source} of sources){
  const formRe=/<form\b[^>]*>/gi;let match;
  while((match=formRe.exec(source))){const tag=match[0],method=attr(tag,'method').toLowerCase();if(method!=='post')continue;const action=attr(tag,'action');if(action.startsWith('/admin/')&&!action.includes('${'))actions.push({path:action,file,kind:'form'});}
  const submitterRe=/<(?:button|input)\b[^>]*formaction=\\?['"]([^'"\\]+)\\?['"][^>]*>/gi;
  while((match=submitterRe.exec(source))){const action=match[1];if(action.startsWith('/admin/')&&!action.includes('${'))actions.push({path:action,file,kind:'formaction'});}
}
const uniqueActions=[...new Map(actions.map(item=>[`${item.file}:${item.kind}:${item.path}`,item])).values()],missing=uniqueActions.filter(action=>!routes.some(route=>sameShape(action.path,route.path)));
if(missing.length){console.error('Visible admin POST/formaction targets without a matching route shape:');for(const item of missing)console.error(` - ${path.relative(root,item.file)} -> ${item.path}`);}
assert.equal(missing.length,0,'Every visible static admin POST/formaction must resolve to a server route');

assert(publicFeedback.includes("hasAttribute?.(name)"),'Enhanced forms must distinguish explicit submitter override attributes from reflected DOM defaults');
assert(publicFeedback.includes("explicitSubmitterAttribute(submitter, 'formaction')"),'Enhanced forms must only honor explicit formaction overrides');
assert(!publicFeedback.includes('submitter?.formAction || form.action'),'Reflected formAction must never override a form action implicitly');
assert(publicFeedback.includes("explicitSubmitterAttribute(submitter, 'formmethod')"),'Enhanced forms must only honor explicit formmethod overrides');
assert(publicFeedback.includes('async function renderHtmlResponse(response)'),'Enhanced forms must display successful POST-rendered HTML pages');
assert(!publicFeedback.includes('finalUrl.href !== window.location.href'),'Enhanced forms must not turn successful POST-rendered pages into GET navigations');
assert(!/DELETE\s+FROM\s+(?:public\.)?audit_log/i.test(customerDeletion)&&!/DELETE\s+FROM\s+(?:public\.)?audit_log/i.test(customerDeletionFinalizer),'Permanent customer deletion must preserve append-only audit history');
assert(customerDeletionFinalizer.includes("set_config('steamfusion.allow_audit_mutation','on',true)")&&customerDeletionFinalizer.includes("set_config('steamfusion.allow_audit_mutation','off',true)"),'Portal-user deletion finalizer must narrowly allow audit actor FK nulling without deleting audit events');
assert(customerDeletionFinalizer.includes("'admin.customer.hard_delete'"),'Permanent customer deletion finalizer must append a deletion tombstone audit event');

const settings=navModel.groups.find(group=>group.key==='settings'),operations=navModel.groups.find(group=>group.key==='operations'),dashboard=navModel.groups.find(group=>group.key==='dashboard'),customers=navModel.groups.find(group=>group.key==='customers'),servers=navModel.groups.find(group=>group.key==='servers'),commerce=navModel.groups.find(group=>group.key==='commerce');
assert(settings&&operations&&dashboard&&customers&&servers&&commerce,'All six fixed navigation groups must exist');
assert.deepStrictEqual(navModel.groups.map(group=>group.key),['dashboard','customers','servers','commerce','operations','settings'],'Permanent navigation group order must remain fixed');
assert.equal(navModel.groups.reduce((sum,group)=>sum+group.pages.length,0),17,'Permanent rail must remain limited to seventeen destinations');
const settingsKeys=settings.pages.map(page=>page[0]),operationsKeys=operations.pages.map(page=>page[0]),dashboardKeys=dashboard.pages.map(page=>page[0]);
assert(!settingsKeys.includes('my-profile'),'Personal My Profile must not be duplicated in global Settings navigation');
assert(settingsKeys.includes('settings-integrations'),'Connections must remain a visible Settings control room');
assert(!settingsKeys.includes('notification-settings'),'Global Notifications must be contextual to Connections rather than a separate Settings rail item');
assert(navModel.hiddenPages?.['notification-settings']?.parentKey==='settings-integrations','Global Notifications must remain addressable from the Connections control room');
assert(!settingsKeys.includes('my-notifications'),'My Notifications must not be duplicated in the Settings rail');
assert(!settingsKeys.includes('settings-commerce'),'Commerce settings must be owned by Commerce → Plans rather than consuming a Settings rail item');
assert(navModel.hiddenPages?.['settings-commerce']?.parentKey==='plans'&&navModel.hiddenPages?.['settings-commerce']?.kind==='setting','Commerce settings must remain addressable as a Plans-owned setting');
assert(!operationsKeys.includes('policy-drift'),'Access consistency is a Provisioning-owned workflow, not a permanent rail destination');
assert(!operationsKeys.includes('notification-gateway'),'Notification delivery health belongs to Connections, not Operations');
assert(!operationsKeys.includes('events'),'Cross-platform audit/event history must be contextual to Automation rather than consuming permanent rail space');
assert(navModel.hiddenPages?.events?.parentKey==='automation-jobs','Audit/event history must remain addressable from Automation');
assert(dashboardKeys.includes('attention'),'Needs attention must be a permanent Dashboard destination');
assert(!navModel.hiddenPages?.attention,'Needs attention must not also exist as a hidden child');
assert(navModel.hiddenPages?.['my-profile'],'Personal profile must remain addressable from the My account area');
assert(navModel.hiddenPages?.['my-notifications'],'Personal notifications must remain addressable as a hidden My Profile workflow page');
assert.equal(navModel.hiddenPages?.['my-notifications']?.parentKey,'my-profile','Personal notifications must remain owned by My Profile');
assert.equal(navModel.groupFor('my-notifications').label,'My account','Personal notification breadcrumb must identify My account rather than global Settings');
assert(navModel.hiddenPages?.['policy-drift'],'Access consistency must remain addressable from Provisioning');
assert(navModel.hiddenPages?.['notification-gateway'],'Notification delivery health must remain addressable from Connections');
assert(navSource.includes("'my-notifications':Object.freeze"),'Hidden personal notification workflow metadata must remain explicit');
assert.equal(navModel.hiddenPages?.['jellyfin-import']?.page?.[1],'Import from Jellyfin','Jellyfin import must use one canonical label in breadcrumbs and navigation');
for(const group of navModel.groups)for(const page of group.pages)assert.deepStrictEqual(navModel.childPages(page[0]),[],`${page[1]} must not create a third rail level`);

const connectionLabels=html=>[...String(html).matchAll(/<strong>([^<]+)<\/strong>/g)].map(match=>match[1]);
const expectedConnections=['Connections','Notifications','Email infrastructure','Request service'];
for(const active of ['connections','notifications','email','requests'])assert.deepStrictEqual(connectionLabels(connectionsWorkflow.tabs(active)),expectedConnections,`Connections navigation must keep one stable order while ${active} is active`);
assert.deepStrictEqual(connectionLabels(notificationWorkflow.globalTabs('global')),expectedConnections,'Notification pages must reuse the exact Connections navigation');
assert(connectionsTabs.includes("['connections','Connections','/admin/settings/integrations'")&&connectionsTabs.includes("['notifications','Notifications','/admin/notifications/preferences'")&&connectionsTabs.includes("['email','Email infrastructure','/admin/notifications'")&&connectionsTabs.includes("['requests','Request service','/admin/request-users'"),'Connections workflow must expose the four canonical destinations');
assert(!connectionsTabs.includes('Delivery health'),'Connections workflow must not create a second email/delivery destination that changes the tab set');
assert(tabs.includes("require('./integration-workflow-tabs')"),'Global notification pages must delegate to the canonical Connections workflow instead of defining another tab set');
assert(tabs.includes("['profile','Profile','/admin/profile'") ,'My Profile workflow must expose Profile');
assert(tabs.includes("['personal','Notifications','/admin/profile/notifications'") ,'My Profile workflow must expose personal Notifications');
assert(provisioningTabs.includes("['provisioning','Provisioning','/admin/provisioning'")&&provisioningTabs.includes("['drift','Access consistency','/admin/provisioning/drift'")&&provisioningTabs.includes('ui.workflowCards'),'Provisioning and access consistency must share one card-based workflow');
assert(html.includes("notificationWorkflow.profileTabs('profile')"),'My Profile must render the personal workflow navigation');
assert(html.includes("notificationWorkflow.profileTabs('personal')"),'My Notifications must render the same personal workflow navigation');
assert(html.includes("notificationWorkflow.globalTabs"),'Global notification pages must use one shared workflow renderer');
assert(html.includes('provisioningTabsFor'),'Provisioning pages must use one shared workflow renderer');
assert(!html.includes("'request-plan-limits':'limits'"),'Retired Request Limits must not remain a workflow-tab destination');
assert(html.includes('canonicalizeRetiredAdminDestinations'),'Retired admin destinations must be canonicalized before rendering');

const duplicateHero='<section class="sectionGraphicHero"><div class="buttonRow"><a class="button" href="/admin/users/new">Add customer</a><a class="button" href="/admin/attention">Fix first issue</a></div></section>';
const pageActions='<a class="button" href="/admin/users/new">Add customer</a><a class="button secondary" href="/admin/jellyfin-import">Import from Jellyfin</a>';
const dedupedHero=htmlCore.dedupeOverviewActions(duplicateHero,pageActions);
assert(!dedupedHero.includes('>Add customer</a>'),'Page-header actions must not be repeated inside overview heroes');
assert(dedupedHero.includes('>Fix first issue</a>'),'Corrective overview actions must survive page-action deduplication');
const localSection='<section class="section"><a class="button" href="/admin/users/new">Section-specific action</a></section>';
assert(htmlCore.dedupeOverviewActions(localSection,pageActions).includes('Section-specific action'),'Section-specific controls must not be stripped by page-action deduplication');

console.log(`admin visible action integrity: ok (${uniqueActions.length} static POST/formaction targets checked)`);
