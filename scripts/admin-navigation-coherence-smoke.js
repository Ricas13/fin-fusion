'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const nav=require('../src/platform/admin-nav');
const context=require('../src/platform/admin-context-navigation');
const html=require('../src/platform/admin-html-core');
const base=require('../src/platform/admin-html-core-base');
const labels=rows=>rows.map(row=>row[1]);

assert.equal(nav.groups.length,6,'rail must expose exactly six sections');
assert.equal(nav.groups.reduce((sum,group)=>sum+group.pages.length,0),19,'rail must expose exactly nineteen permanent destinations');
for(const parent of ['dashboard','users','servers','stremio-sources','activity','plans','orders','discounts','referrals','payments','provisioning','automation-jobs','backups','settings-general','settings-security','settings-integrations']){
  assert.deepStrictEqual(nav.childPages(parent),[],`${parent} must not render third-level rail children`);
}

assert.deepStrictEqual(labels(nav.viewsFor('servers')),['Fleet dashboard','Placement & capacity'],'Servers must keep its data views parent-owned');
assert.deepStrictEqual(labels(nav.viewsFor('users')),['Customer activity'],'Customers must keep activity as a parent-owned view');
assert.deepStrictEqual(labels(nav.tasksFor('users')),['Imported-user claims','Import from Jellyfin','Jellyfin password support'],'Customer support/import jobs must be parent-owned tasks');
const planSettings=labels(nav.settingsFor('plans'));
for(const label of ['Access rules','Storefront order','Commerce settings'])assert(planSettings.includes(label),`Plans setting bank missing ${label}`);
assert(labels(nav.settingsFor('activity')).includes('Free-user inactivity rules'),'Playback must own inactivity rules as a setting');
assert(labels(nav.settingsFor('stremio-sources')).includes('IP access'),'Stremio must own IP access as a setting');
const commercePages=nav.groups.find(group=>group.key==='commerce').pages;
assert.deepStrictEqual(labels(commercePages),['Plans','Orders','Discounts','Affiliates','Payments'],'Commerce must expose the canonical five permanent destinations');
assert(!labels(nav.relatedPages('orders')).includes('Discounts')&&!labels(nav.relatedPages('orders')).includes('Affiliates'),'Discounts and Affiliates must not remain hidden Orders-related pages');
assert(labels(nav.relatedPages('payments')).includes('Billing')&&labels(nav.relatedPages('payments')).includes('Expenses & Profitability'),'Payments must keep billing/profitability pages related but out of the rail');
assert(labels(nav.tasksFor('backups')).includes('Export data')&&labels(nav.tasksFor('backups')).includes('Configuration Transfer'),'Backups must own portability tasks');

for(const [key,parent] of [['expenses','payments'],['transactions','payments'],['refunds','payments'],['data-export','backups'],['legacy-paid-import','backups'],['libraries','servers']]){
  assert.strictEqual(nav.sidebarKey(key),parent,`${key} must keep ${parent} highlighted as its owning rail destination`);
}
assert.strictEqual(nav.sidebarKey('discounts'),'discounts','Discounts must highlight its own permanent Commerce destination');
assert.strictEqual(nav.sidebarKey('referrals'),'referrals','Affiliates must highlight its own permanent Commerce destination');

const expenseHeader=base.header('expenses','CAPTAiNFiN');
assert(/adminTab active[^>]*href="\/admin\/payments"/.test(expenseHeader),'Expenses must keep Payments highlighted as its parent');
assert(!expenseHeader.includes('class="adminSubTab'),'Expenses must not manufacture a third-level sidebar entry');
assert(!expenseHeader.includes('href="/admin/expenses"'),'Expenses must remain outside permanent rail markup');
assert(!expenseHeader.includes('href="/admin/billing"'),'Billing must remain outside permanent rail markup');

const migrationHeader=base.header('legacy-paid-import','CAPTAiNFiN');
assert(/adminTab active[^>]*href="\/admin\/backups"/.test(migrationHeader),'Paid-user migration must keep Backups highlighted as its parent');
assert(!migrationHeader.includes('href="/admin/payments/legacy-import"'),'Paid-user migration must not become a third-level rail entry');

const expenseCrumb=context.breadcrumb('expenses');
assert(expenseCrumb.includes('<a href="/admin/payments">Payments</a>'),'Expense breadcrumb must link back to its owning main page');
assert(expenseCrumb.includes('<strong>Expenses &amp; Profitability</strong>'),'Expense breadcrumb must identify the specialist page');

const rendered=html.layout({
  active:'payments',
  title:'Payments',
  subtitle:'Payment provider health',
  action:'<a class="button" href="/admin/expenses?new=1">Add expense</a>',
  body:'<section id="navigation-coherence-sentinel">sentinel</section><section class="coherenceOwnedTools"><a href="/admin/expenses">old hidden directory</a></section>'
});
assert(rendered.includes('href="/admin/payments"'),'Payments must remain a permanent rail destination');
for(const hiddenHref of ['/admin/billing','/admin/expenses','/admin/payments/transactions','/admin/refunds','/admin/payments/export','/admin/provider-mappings','/admin/payments/risk-policy']){
  assert(!rendered.includes(`href="${hiddenHref}"`),`${hiddenHref} must stay out of permanent rail navigation`);
}
assert(!rendered.includes('old hidden directory'),'Legacy bottom-of-page navigation directories must be stripped');
assert(!rendered.includes('class="workflowCardGrid coherenceSectionTabs"'),'Main section tabs must not duplicate the sidebar');
assert(!rendered.includes('class="coherenceSubTabs"'),'Secondary tab rows must not survive');
assert(!rendered.includes('class="workflowCardGrid operatorTabs"'),'Legacy workflow tab rows must not survive');
assert(!rendered.includes('class="coherenceOwnedTools"'),'Navigation must never be appended below page content');
assert.strictEqual(base.paymentTabsFor({title:'Payments'}),'','Payment-specific top tabs must remain retired');
assert(/topBreadcrumb[\s\S]*<a href="\/admin\/plans">Commerce<\/a>/.test(rendered),'Breadcrumb ancestry must remain available after removing duplicate tabs');
assert(rendered.indexOf('/js/operator-experience.js')<rendered.indexOf('/js/admin-navigation-coherence.js'),'Sidebar-only cleanup must run after the legacy operator enhancer');

const baseSource=read('src/platform/admin-html-core-base.js');
assert(baseSource.includes('function sidebarPage'),'Shared admin chrome must render permanent sidebar destinations server-side');
assert(!baseSource.includes('adminSubTab'),'Shared admin chrome must contain no third-level rail markup or styling');
assert(!baseSource.includes('nav.childPages('),'Rail rendering must not pull specialist children back into navigation');
assert(baseSource.includes('.navSection[open] .navSectionPages{display:grid}'),'Navigation sections must remain expandable inside the drawer');

const coreSource=read('src/platform/admin-html-core.js');
assert(!coreSource.includes('contextNavigation.render(options.active)'),'Shared rendering must not add a duplicate top navigation row');
assert(!coreSource.includes('renderOwnedTools(options.active)'),'Shared rendering must not append navigation below page content');
assert(coreSource.includes('coherenceOwnedTools'),'Cleanup must remove stale bottom directories emitted by legacy callers');

const fallback=read('public/js/admin-navigation-coherence.js');
assert(fallback.includes('function enforceSidebarOnlyNavigation()'),'Client enhancement must enforce sidebar-only navigation on legacy pages');
assert(fallback.includes("'nav.workflowCardGrid,nav.operatorTabs,nav.coherenceSectionTabs,nav.coherenceSubTabs,section.coherenceOwnedTools'"),'Client cleanup must remove both server-rendered and dynamically injected workflow navigation');
assert(!fallback.includes('appendOwnedTools'),'Client code must never recreate hidden bottom-of-page navigation');
assert(!fallback.includes('fallbackNav('),'Client code must not rebuild duplicate top section tabs');
assert(!fallback.includes('installMobileAdminDrawer'),'Client coherence code must not own a second mobile drawer');
assert(fallback.includes('function movePageActionsToHeading()'),'Admin enhancement must move page-scoped controls beside the page heading');
assert(fallback.includes("utilitySelector='.topStatusWrap,.topHelpLink,.topHeaderMetrics'"),'Status, Help and read-only metrics must remain global top-bar utilities');
assert(fallback.includes("target.className='pageHeaderActions'")&&fallback.includes("target.setAttribute('aria-label','Page actions')"),'Page actions must have a dedicated accessible heading control region');
assert(fallback.includes('actions.forEach(node=>target.appendChild(node))'),'Existing action nodes must be moved rather than cloned');
assert(fallback.includes('function watchLatePageActions()')&&fallback.includes('new MutationObserver'),'Late asynchronous page controls must not drift back into the global top bar');

const css=read('public/css/admin-navigation-coherence.css');
assert(css.includes('.content>.pageHeader{display:flex'),'Page headings must reserve layout space for contextual controls');
assert(css.includes('.pageHeaderActions{display:flex'),'Page actions must use a dedicated responsive action layout');
assert(css.includes('@media(max-width:760px){.content>.pageHeader{flex-direction:column'),'Page actions must stack below the heading on narrow screens');

console.log('admin navigation coherence smoke: ok');
