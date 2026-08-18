'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const root=path.join(__dirname,'..');
const platformDir=path.join(root,'src','platform');
const publicFeedback=fs.readFileSync(path.join(root,'public','js','admin-form-feedback.js'),'utf8');
const navSource=fs.readFileSync(path.join(platformDir,'admin-nav.js'),'utf8');
const navModel=require('../src/platform/admin-nav');
const tabs=fs.readFileSync(path.join(platformDir,'notification-workflow-tabs.js'),'utf8');
const provisioningTabs=fs.readFileSync(path.join(platformDir,'provisioning-workflow-tabs.js'),'utf8');
const html=fs.readFileSync(path.join(platformDir,'admin-html.js'),'utf8');

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

const settings=navModel.groups.find(group=>group.key==='settings'),automation=navModel.groups.find(group=>group.key==='automation'),dashboard=navModel.groups.find(group=>group.key==='dashboard');
assert(settings&&automation&&dashboard,'Core navigation groups must exist');
const settingsKeys=settings.pages.map(page=>page[0]),automationKeys=automation.pages.map(page=>page[0]),dashboardKeys=dashboard.pages.map(page=>page[0]);
assert(!settingsKeys.includes('my-profile'),'Personal My Profile must not be duplicated in global Settings navigation');
assert(settingsKeys.includes('notification-settings'),'Global Notifications must remain a Settings sidebar item');
assert(!settingsKeys.includes('my-notifications'),'My Notifications must not be duplicated in the Settings sidebar');
assert(!settingsKeys.includes('settings-commerce'),'Unused Settings > Commerce must not be shown');
assert(!automationKeys.includes('policy-drift'),'Policy Drift is a Provisioning sub-workflow, not a first-class sidebar destination');
assert(!automationKeys.includes('notification-gateway'),'Notification delivery health belongs to the Notifications workflow, not Automation');
assert(automationKeys.includes('events'),'Cross-platform audit/event history belongs with operational automation, not the dashboard landing group');
assert(!dashboardKeys.includes('events'),'Dashboard navigation should remain focused on current state and action');
assert(navModel.hiddenPages?.['my-profile'],'Personal profile must remain addressable from the My account area');
assert(navModel.hiddenPages?.['my-notifications'],'Personal notifications must remain addressable as a hidden My Profile workflow page');
assert.equal(navModel.hiddenPages?.['my-notifications']?.parentKey,'my-profile','Personal notifications must remain owned by My Profile');
assert.equal(navModel.groupFor('my-notifications').label,'My account','Personal notification breadcrumb must identify My account rather than global Settings');
assert(navModel.hiddenPages?.['policy-drift'],'Policy Drift must remain addressable from Provisioning');
assert(navModel.hiddenPages?.['notification-gateway'],'Notification delivery health must remain addressable from Notifications');
assert(navSource.includes("'my-notifications':Object.freeze"),'Hidden personal notification workflow metadata must remain explicit');

assert(tabs.includes("['global','Global notifications','/admin/notifications/preferences']"),'Global notification workflow must expose Global notifications');
assert(tabs.includes("['email','Email infrastructure','/admin/notifications/email']"),'Global notification workflow must expose Email infrastructure');
assert(tabs.includes("['health','Delivery health','/admin/notifications']"),'Global notification workflow must expose delivery health without a duplicate sidebar item');
assert(tabs.includes("['profile','Profile','/admin/profile']"),'My Profile workflow must expose Profile');
assert(tabs.includes("['personal','Notifications','/admin/profile/notifications']"),'My Profile workflow must expose personal Notifications');
assert(provisioningTabs.includes("['provisioning','Provisioning','/admin/provisioning']")&&provisioningTabs.includes("['drift','Policy drift','/admin/provisioning/drift']"),'Provisioning and policy drift must share one stable workflow');
assert(html.includes("notificationWorkflow.profileTabs('profile')"),'My Profile must render the personal workflow tabs');
assert(html.includes("notificationWorkflow.profileTabs('personal')"),'My Notifications must render the same personal workflow tabs');
assert(html.includes("notificationWorkflow.globalTabs"),'Global notification pages must use a separate stable tab set');
assert(html.includes('provisioningTabsFor'),'Provisioning pages must use a stable workflow tab set');

console.log(`admin visible action integrity: ok (${uniqueActions.length} static POST/formaction targets checked)`);
