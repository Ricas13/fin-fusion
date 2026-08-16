'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const html=read('src/platform/admin-html.js');
const core=read('src/platform/admin-html-core.js');
const catalog=read('src/platform/admin-catalog-shell.js');
const navModel=require('../src/platform/admin-nav');
const baseCss=read('public/css/admin-original-base.css');
const componentCss=read('public/css/admin-original-components.css');
const refinementCss=read('public/css/admin-visual-refinement.css');
const plans=read('src/platform/admin-plans-list.js');
const formFeedback=read('public/js/admin-form-feedback.js');

assert(html.includes('decorateSettingHelp'),'Shared admin renderer must decorate settings with helper descriptions');
assert(html.includes('SETTING_HELP'),'Shared setting-help registry must exist');
assert(core.includes('topBreadcrumb'),'Admin shell must render a stable top breadcrumb');
assert(core.includes('<details class="navSection'),'Admin navigation groups must be collapsible');
assert(core.includes("${activeGroup?'open':''}"),'The active navigation group must start expanded');
assert(core.includes('/css/admin-visual-refinement.css'),'Admin shell must load the visual refinement layer');
const commerceGroup=navModel.groups.find(group=>group.key==='commerce');
assert(commerceGroup&&!commerceGroup.pages.some(page=>page[0]==='billing'),'Billing must not render as a left-sidebar Commerce child');
const billingGroup=navModel.groupFor('billing');
assert(billingGroup.key==='commerce'&&billingGroup.pages.some(page=>page[0]==='billing'),'Billing must remain a routable Commerce workflow page for breadcrumb context');
assert(catalog.includes('name="streams"'),'New plan form must expose a concurrent-stream rule');
assert(catalog.includes("int(body.streams,1,50,'Concurrent streams')"),'New plan creation must validate concurrent streams from 1 to 50');
assert(catalog.includes('sort_order,streams,allow_remuxing'),'New plan creation must persist the stream limit into plans.streams');
assert(catalog.includes('streams:plan.streams'),'Plan creation audit metadata must record the selected stream limit');
assert(catalog.includes('This limit applies to Jellyfin, Stremio and bundle delivery.'),'Concurrent-stream help must make Stremio applicability explicit');
assert(baseCss.includes('--sidebar-w:248px'),'Desktop admin shell should use the wider visual-hierarchy sidebar');
assert(componentCss.includes('.fieldHelp'),'Admin controls must have a consistent helper-description style');
assert(componentCss.includes('min-height:40px'),'Admin controls must use the larger readable control size');
assert(refinementCss.includes('.navSection[open] .navSectionPages'),'Accordion CSS must expose only expanded navigation groups on desktop');
assert(refinementCss.includes('.settings-grid{grid-template-columns:repeat(2,minmax(0,1fr))'),'Settings must use broad two-column cards on large screens');
assert(refinementCss.includes('.formGrid{grid-template-columns:repeat(3,minmax(0,1fr))'),'Wide forms must be capped at three columns');
assert(refinementCss.includes('.planListToolbar{display:grid'),'Plan filters must render as a compact toolbar');
assert(refinementCss.includes('.planListFilteredEmpty{display:none'),'Filtered-empty feedback must be hidden while plans are visible');
assert(refinementCss.includes('.chartEmpty{height:108px}'),'Empty dashboard charts must not dominate vertical space');
assert(plans.includes('data-plan-table-wrap'),'Plan filtering must be able to hide the table when no rows match');
assert(formFeedback.includes("actionPath(form) === '/admin/notifications/preferences/delivery'"),'Notification credential forms must use native browser submission for reliable CSRF handling');
assert(formFeedback.includes('submitter?.formAction'),'Enhanced forms must honor per-button formaction targets');
assert(formFeedback.includes("'X-CSRF-Token': csrfToken"),'Enhanced admin POSTs must mirror the CSRF token in the request header');
assert(formFeedback.includes('async function responseMessage(response)'),'Admin form errors must surface the server rejection reason instead of a generic HTTP status');

console.log('admin UX foundation smoke: ok');
