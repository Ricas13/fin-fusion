'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const ui=require('../src/platform/admin-ui');

const badge=ui.statusBadge('<Ready>','good');
assert(badge.includes('pill good'),'status badge must retain canonical pill styling');
assert(badge.includes('&lt;Ready&gt;')&&!badge.includes('<Ready>'),'status badge labels must be escaped');
assert(!ui.statusBadge('Bad kind','javascript:bad').includes('javascript:bad'),'status badge kinds must be allow-listed');

const error=ui.notice('error','<unsafe>',{title:'Problem'});
assert(error.includes('role="alert"')&&error.includes('&lt;unsafe&gt;')&&!error.includes('<unsafe>'),'error notices must be accessible and escape content');
const success=ui.noticesFromRequest({query:{message:'Saved',error:'Failed'}});
assert(success.includes('notice success')&&success.includes('notice error'),'request feedback must share one notice renderer');

const empty=ui.emptyState({title:'Nothing here',body:'Create one next.',actionHref:'/admin/example?a=<x>',actionLabel:'Create <item>',tone:'success'});
assert(empty.includes('uiEmptyState-success')&&empty.includes('/admin/example?a=&lt;x&gt;')&&empty.includes('Create &lt;item&gt;'),'empty states must escape content and action metadata');

const header=ui.sectionHeader({title:'Section <one>',description:'Description',eyebrow:'Optional'});
assert(header.includes('uiSectionHeader')&&header.includes('Section &lt;one&gt;')&&header.includes('uiEyebrow'),'section headings must share one semantic structure');

const workflow=ui.workflowCards([
  ['one','Card <one>','/admin/example?a=<x>','Description <unsafe>'],
  ['two','Second','/admin/second','More']
],'one','Example workflow');
assert(workflow.includes('workflowCardGrid')&&workflow.includes('workflowCard active')&&workflow.includes('aria-current="page"'),'workflow cards must expose the active control-room destination semantically');
assert(workflow.includes('Card &lt;one&gt;')&&workflow.includes('Description &lt;unsafe&gt;')&&workflow.includes('/admin/example?a=&lt;x&gt;'),'workflow cards must escape labels, descriptions and links');

const confirm=ui.confirmationPanel({tone:'danger',title:'Confirm change',body:'Review this first.',items:['<one>','two']});
assert(confirm.includes('uiConfirmPanel-danger')&&confirm.includes('&lt;one&gt;')&&!confirm.includes('<one>'),'confirmation panels must escape customer/operator data');
const danger=ui.dangerZone({title:'Danger zone',description:'Permanent changes live here.',actionsHtml:'<button class="button btn-danger">Delete</button>'});
assert(danger.includes('uiDangerZone')&&danger.includes('btn-danger'),'danger zones must provide a standard destructive-action container');

const capability=read('public/css/admin-capability.css');
const css=read('public/css/admin-ui-primitives.css');
const visual=read('public/css/admin-visual-refinement.css');
const tokens=read('public/css/admin-tokens.css');
const legacyHead=read('views/admin/_head.ejs');
assert(capability.includes("@import url('/css/admin-ui-primitives.css')"),'shared UI styles must load globally through the admin capability layer');
for(const token of ['.uiSectionHeader','.uiEmptyState','.uiConfirmPanel','.uiDangerZone','@media(max-width:700px)'])assert(css.includes(token),`shared UI CSS missing ${token}`);
assert(visual.includes('.workflowCardGrid{position:relative;top:auto;z-index:auto')&&visual.includes('display:flex!important')&&visual.includes('margin:0 0 18px'),'workflow navigation must remain compact and reserve normal-flow space below the admin header');
assert(visual.includes('.workflowCard>span:not(.workflowCardEyebrow),.workflowCard>small{display:none}'),'compact workflow navigation must not expand into descriptive content cards');
assert(visual.includes('.pageHeader + .operatorTabs{position:relative;top:auto;z-index:auto')&&visual.includes('margin:0 0 16px'),'top-level page tabs must stay in normal flow so they cannot overlap page content');
assert(tokens.includes('--rail-w:240px')&&tokens.includes('--bar-h:56px'),'canonical admin tokens must own desktop shell geometry');
assert(legacyHead.includes('--sidebar-w:var(--rail-w)')&&legacyHead.includes('--bar-h'),'legacy EJS pages must consume the same tokenized shell geometry');
assert(legacyHead.includes('/css/admin-visual-refinement.css')&&legacyHead.includes('/css/admin-capability.css')&&legacyHead.includes('/css/admin-tokens.css'),'legacy EJS pages must load shared refinement, capability and token styles');
assert(legacyHead.includes('.mainPane,.adminMain')&&legacyHead.includes('.content,.pageContent'),'legacy and canonical shell containers must share the same geometry rules');

const integration=read('src/platform/admin-integration-card.js');
const attention=read('src/platform/admin-attention.js');
const setup=read('src/platform/admin-setup.js');
const inventory=read('src/platform/admin-plan-inventory.js');
assert(integration.includes("require('./admin-ui')")&&integration.includes('ui.statusBadge(statusLabel, statusKind)'),'integration cards must consume the shared status primitive');
for(const token of ["require('./admin-ui')",'ui.noticesFromRequest(req)','ui.emptyState(','ui.sectionHeader(','ui.statusBadge('])assert(attention.includes(token),`Needs Attention has not migrated ${token}`);
assert(setup.includes("require('./admin-ui')")&&setup.includes('ui.emptyState(')&&setup.includes('ui.statusBadge('),'Setup must use shared status and empty-state primitives');
assert(inventory.includes("require('./admin-ui')")&&inventory.includes('ui.confirmationPanel(')&&inventory.includes('ui.noticesFromRequest(req)'),'plan Availability must use shared confirmation and feedback primitives');

console.log('shared admin UI smoke: ok');
