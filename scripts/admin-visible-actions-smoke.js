'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const root=path.join(__dirname,'..');
const platformDir=path.join(root,'src','platform');
const publicFeedback=fs.readFileSync(path.join(root,'public','js','admin-form-feedback.js'),'utf8');
const nav=fs.readFileSync(path.join(platformDir,'admin-nav.js'),'utf8');
const tabs=fs.readFileSync(path.join(platformDir,'notification-workflow-tabs.js'),'utf8');
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

function sameShape(a,b){
  const x=canonicalSegments(a),y=canonicalSegments(b);
  if(x.length!==y.length)return false;
  return x.every((segment,index)=>segment===':'||y[index]===':'||segment===y[index]);
}

function attr(tag,name){
  const match=tag.match(new RegExp(`${name}=\\\\?['\"]([^'\"\\\\]+)\\\\?['\"]`,'i'));
  return match?match[1]:'';
}

const files=jsFiles(platformDir);
const sources=files.map(file=>({file,source:fs.readFileSync(file,'utf8')}));
const routes=[];
for(const {file,source} of sources){
  const routeRe=/\.(post|all)\(\s*['"`]([^'"`]+)['"`]/g;
  let match;
  while((match=routeRe.exec(source)))routes.push({method:match[1],path:match[2],file});
}

const actions=[];
for(const {file,source} of sources){
  const formRe=/<form\b[^>]*>/gi;
  let match;
  while((match=formRe.exec(source))){
    const tag=match[0],method=attr(tag,'method').toLowerCase();
    if(method!=='post')continue;
    const action=attr(tag,'action');
    if(action.startsWith('/admin/')&&!action.includes('${'))actions.push({path:action,file,kind:'form'});
  }
  const submitterRe=/<(?:button|input)\b[^>]*formaction=\\?['"]([^'"\\]+)\\?['"][^>]*>/gi;
  while((match=submitterRe.exec(source))){
    const action=match[1];
    if(action.startsWith('/admin/')&&!action.includes('${'))actions.push({path:action,file,kind:'formaction'});
  }
}

const uniqueActions=[...new Map(actions.map(item=>[`${item.file}:${item.kind}:${item.path}`,item])).values()];
const missing=uniqueActions.filter(action=>!routes.some(route=>sameShape(action.path,route.path)));
if(missing.length){
  console.error('Visible admin POST/formaction targets without a matching route shape:');
  for(const item of missing)console.error(` - ${path.relative(root,item.file)} -> ${item.path}`);
}
assert.equal(missing.length,0,'Every visible static admin POST/formaction must resolve to a server route');

assert(publicFeedback.includes("hasAttribute?.(name)"),'Enhanced forms must distinguish explicit submitter override attributes from reflected DOM defaults');
assert(publicFeedback.includes("explicitSubmitterAttribute(submitter, 'formaction')"),'Enhanced forms must only honor explicit formaction overrides');
assert(!publicFeedback.includes('submitter?.formAction || form.action'),'Reflected formAction must never override a form action implicitly');
assert(publicFeedback.includes("explicitSubmitterAttribute(submitter, 'formmethod')"),'Enhanced forms must only honor explicit formmethod overrides');

assert(nav.includes("['my-profile','My Profile','/admin/profile']"),'My Profile must remain a dedicated Settings sidebar item');
assert(nav.includes("['notification-settings','Notifications','/admin/notifications/preferences']"),'Global Notifications must remain a Settings sidebar item');
assert(!nav.includes("['my-notifications','My Notifications','/admin/profile/notifications']"),'My Notifications must not be duplicated in the Settings sidebar');
assert(!nav.includes("['settings-commerce','Commerce','/admin/settings?section=commerce']"),'Unused Settings > Commerce must not be shown');
assert(nav.includes("'my-notifications':Object.freeze"),'Personal notifications must remain addressable as a hidden My Profile workflow page');

assert(tabs.includes("['global','Global notifications','/admin/notifications/preferences']"),'Global notification workflow must expose Global notifications');
assert(tabs.includes("['email','Email infrastructure','/admin/notifications/email']"),'Global notification workflow must expose Email infrastructure');
assert(tabs.includes("['profile','Profile','/admin/profile']"),'My Profile workflow must expose Profile');
assert(tabs.includes("['personal','Notifications','/admin/profile/notifications']"),'My Profile workflow must expose personal Notifications');
assert(html.includes("notificationWorkflow.profileTabs('profile')"),'My Profile must render the personal workflow tabs');
assert(html.includes("notificationWorkflow.profileTabs('personal')"),'My Notifications must render the same personal workflow tabs');
assert(html.includes("notificationWorkflow.globalTabs"),'Global notification pages must use a separate stable tab set');

console.log(`admin visible action integrity: ok (${uniqueActions.length} static POST/formaction targets checked)`);
