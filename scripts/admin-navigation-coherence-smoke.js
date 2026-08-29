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

// Every durable specialist destination belongs to its owning sidebar page.
assert.deepStrictEqual(
  labels(nav.childPages('plans')),
  ['Storefront order','Access rules'],
  'Plans & Storefront must expose its specialist tools directly in the sidebar'
);
assert.deepStrictEqual(
  labels(nav.childPages('orders')),
  ['Analytics','Discounts','Affiliates','Marketing'],
  'Orders & Growth must expose analytics, discounts, affiliates and marketing in the sidebar'
);
assert.deepStrictEqual(
  labels(nav.childPages('payments')),
  ['Billing','Transactions','Prepaid refunds','Export data','Expenses & Profitability','Provider mappings','Payment risk'],
  'Payments & Billing must expose every billing tool in the sidebar'
);
assert.deepStrictEqual(
  labels(nav.childPages('backups')),
  ['Configuration Transfer','Migrate paid users'],
  'Migrate paid users belongs beside Configuration Transfer: it is the import half of that export/restore round-trip, not a Payments & Billing tool'
);
assert(nav.hiddenPages['server-migrations']?.parentKey==='provisioning'&&nav.SIDEBAR_EXCLUDED_CHILDREN.has('server-migrations'),'Customer moves is reached from Customer 360 and must not duplicate that entry point in the sidebar');
assert.deepStrictEqual(
  labels(nav.childPages('servers')),
  ['Fleet dashboard','Placement & capacity'],
  'Jellyfin Servers must expose durable specialist destinations while omitting scan-only Libraries'
);
assert(nav.hiddenPages.libraries?.parentKey==='servers'&&nav.SIDEBAR_EXCLUDED_CHILDREN.has('libraries'),'Libraries must remain a direct compatibility/scan utility without a permanent sidebar slot');
assert(labels(nav.childPages('activity')).includes('Free-user inactivity rules'),'Playback must expose its inactivity policy in the sidebar');
assert(labels(nav.childPages('settings-security')).includes('Turnstile & abuse protection'),'Security must expose abuse protection in the sidebar');
assert.deepStrictEqual(
  labels(nav.childPages('users')),
  ['Customer activity','Imported-user claims','Import from Jellyfin','Jellyfin password support'],
  'Customers must expose durable support and import destinations directly in the sidebar'
);

// Specialist pages keep their owning main page highlighted while highlighting
// their own nested destination as the exact current location.
assert.strictEqual(nav.sidebarKey('expenses'),'payments');
assert.strictEqual(nav.sidebarKey('transactions'),'payments');
assert.strictEqual(nav.sidebarKey('refunds'),'payments');
assert.strictEqual(nav.sidebarKey('data-export'),'payments');
assert.strictEqual(nav.sidebarKey('legacy-paid-import'),'backups');
assert.strictEqual(nav.sidebarKey('discounts'),'orders');
assert.strictEqual(nav.sidebarKey('libraries'),'servers');
const expenseHeader=base.header('expenses','CAPTAiNFiN');
assert(/adminTab active[^>]*href="\/admin\/payments"/.test(expenseHeader),'Expenses must keep Payments & Billing highlighted as its parent');
assert(/adminSubTab active[^>]*href="\/admin\/expenses"[^>]*aria-current="page"/.test(expenseHeader),'Expenses must be directly highlighted as the current nested sidebar destination');
assert(expenseHeader.includes('href="/admin/billing"')&&expenseHeader.includes('href="/admin/payments/transactions"')&&expenseHeader.includes('href="/admin/refunds"')&&expenseHeader.includes('href="/admin/payments/export"')&&expenseHeader.includes('href="/admin/provider-mappings"')&&expenseHeader.includes('href="/admin/payments/risk-policy"'),'Sibling payment tools must remain visible without scrolling through page content');
const migrationHeader=base.header('legacy-paid-import','CAPTAiNFiN');
assert(/adminTab active[^>]*href="\/admin\/backups"/.test(migrationHeader),'Paid-user migration must keep Backups & Recovery highlighted as its parent, beside Configuration Transfer');
assert(/adminSubTab active[^>]*href="\/admin\/payments\/legacy-import"[^>]*aria-current="page"/.test(migrationHeader),'Paid-user migration must highlight its nested entry');
assert(migrationHeader.includes('href="/admin/configuration"'),'Paid-user migration must render beside Configuration Transfer, its export/restore counterpart');

const discountHeader=base.header('discounts','CAPTAiNFiN');
assert(/adminTab active[^>]*href="\/admin\/commerce\/orders"/.test(discountHeader),'Discounts must keep Orders & Growth highlighted');
assert(/adminSubTab active[^>]*href="\/admin\/discounts"/.test(discountHeader),'Discounts must highlight its nested entry');

// Breadcrumbs remain for orientation, but page-body navigation is retired.
const expenseCrumb=context.breadcrumb('expenses');
assert(expenseCrumb.includes('<a href="/admin/payments">Payments &amp; Billing</a>'),'Expense breadcrumb must link back to its owning main page');
assert(expenseCrumb.includes('<strong>Expenses &amp; Profitability</strong>'),'Expense breadcrumb must identify the specialist page');

const rendered=html.layout({
  active:'payments',
  title:'Payments',
  subtitle:'Payment provider health',
  action:'<a class="button" href="/admin/expenses?new=1">Add expense</a>',
  body:'<section id="navigation-coherence-sentinel">sentinel</section><section class="coherenceOwnedTools"><a href="/admin/expenses">old hidden directory</a></section>'
});
assert(rendered.includes('href="/admin/expenses"'),'Expenses must be reachable from the canonical sidebar');
assert(rendered.includes('href="/admin/payments/transactions"'),'Transactions must be reachable from the canonical sidebar');
assert(rendered.includes('href="/admin/refunds"'),'Prepaid refunds must be reachable from the canonical sidebar');
assert(rendered.includes('href="/admin/payments/export"'),'Export data must be reachable from the canonical sidebar');
assert(!rendered.includes('old hidden directory'),'Legacy bottom-of-page navigation directories must be stripped');
assert(!rendered.includes('class="workflowCardGrid coherenceSectionTabs"'),'Main section tabs must not duplicate the sidebar');
assert(!rendered.includes('class="coherenceSubTabs"'),'Secondary tab rows must not survive');
assert(!rendered.includes('class="workflowCardGrid operatorTabs"'),'Legacy workflow tab rows must not survive');
assert(!rendered.includes('class="coherenceOwnedTools"'),'Navigation must never be appended below page content');
assert.strictEqual(base.paymentTabsFor({title:'Payments'}),'','Payment-specific top tabs must be retired in favour of nested sidebar navigation');
assert(/topBreadcrumb[\s\S]*<a href="\/admin\/plans">Commerce<\/a>/.test(rendered),'Breadcrumb ancestry must remain available after removing duplicate tabs');
assert(rendered.indexOf('/js/operator-experience.js')<rendered.indexOf('/js/admin-navigation-coherence.js'),'Sidebar-only cleanup must run after the legacy operator enhancer so dynamically injected workflow menus are removed');

const baseSource=read('src/platform/admin-html-core-base.js');
assert(baseSource.includes('function sidebarPage'),'Shared admin chrome must render nested sidebar destinations server-side');
assert(baseSource.includes('nav.childPages(key)'),'Sidebar children must come from the same admin-nav source of truth');
assert(baseSource.includes('.adminSubTab.active'),'Nested active state must have a dedicated visual treatment');
assert(baseSource.includes('.navSection[open] .navSectionPages{display:grid}'),'Mobile navigation must remain expandable rather than becoming one enormous horizontal list');

const coreSource=read('src/platform/admin-html-core.js');
assert(!coreSource.includes('contextNavigation.render(options.active)'),'Shared rendering must not add a duplicate top navigation row');
assert(!coreSource.includes('renderOwnedTools(options.active)'),'Shared rendering must not append navigation below page content');
assert(coreSource.includes('coherenceOwnedTools'),'Cleanup must remove stale bottom directories emitted by legacy callers');

const fallback=read('public/js/admin-navigation-coherence.js');
assert(fallback.includes('function enforceSidebarOnlyNavigation()'),'Client enhancement must enforce sidebar-only navigation on legacy pages');
assert(fallback.includes("'nav.workflowCardGrid,nav.operatorTabs,nav.coherenceSectionTabs,nav.coherenceSubTabs,section.coherenceOwnedTools'"),'Client cleanup must remove both server-rendered and dynamically injected workflow navigation');
assert(!fallback.includes('appendOwnedTools'),'Client code must never recreate hidden bottom-of-page navigation');
assert(!fallback.includes('fallbackNav('),'Client code must not rebuild duplicate top section tabs');
assert(fallback.includes('function movePageActionsToHeading()'),'Admin enhancement must move page-scoped controls beside the page heading');
assert(fallback.includes("utilitySelector='.topStatusWrap,.topHelpLink,.topHeaderMetrics'"),'Status, Help and read-only metrics must remain global top-bar utilities');
assert(fallback.includes("target.className='pageHeaderActions'")&&fallback.includes("target.setAttribute('aria-label','Page actions')"),'Page actions must have a dedicated accessible heading control region');
assert(fallback.includes('actions.forEach(node=>target.appendChild(node))'),'Existing action nodes must be moved rather than cloned so forms and handlers stay intact');
assert(fallback.includes('function watchLatePageActions()')&&fallback.includes('new MutationObserver'),'Late asynchronous page controls must not drift back into the global top bar');
assert(fallback.includes("observer.observe(topActions,{childList:true})"),'The top utility bar must be watched for late page-scoped actions');

const css=read('public/css/admin-navigation-coherence.css');
assert(css.includes('.content>.pageHeader{display:flex'),'Page headings must reserve layout space for contextual controls');
assert(css.includes('.pageHeaderActions{display:flex'),'Page actions must use a dedicated responsive action layout');
assert(css.includes('@media(max-width:760px){.content>.pageHeader{flex-direction:column'),'Page actions must stack below the heading on narrow screens');

console.log('admin navigation coherence smoke: ok');
