'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const context=require('../src/platform/admin-context-navigation');
const html=require('../src/platform/admin-html-core');
const finance=require('../src/platform/finance-ledger');
const paymentFinancials=require('../src/payments/payment-financials');

const keys=rows=>rows.map(row=>row[0]);
const labels=rows=>rows.map(row=>row[1]);

// The upper hierarchy has one level only. Hidden/specialist destinations must
// select their owning main tab instead of creating another row underneath it.
assert.deepStrictEqual(
  keys(context.sectionPages('branding')),
  ['settings-general','settings-security','settings-integrations','settings-commerce','system'],
  'Settings child pages must preserve the one main Settings row'
);
assert.strictEqual(context.sectionActiveKey('branding'),'settings-general','Branding must remain owned by Settings → General');
assert.strictEqual(context.sectionActiveKey('discounts'),'orders','Discounts must remain owned by Commerce → Orders & Growth');
assert.strictEqual(context.sectionActiveKey('finance'),'orders','Finance must remain owned by Commerce → Orders & Growth');
assert.strictEqual(context.sectionActiveKey('commerce-overview'),'orders','Commerce analytics must now live inside Orders & Growth rather than becoming another upper tab');
assert.strictEqual(context.sectionActiveKey('provider-mappings'),'payments','Provider mappings must remain owned by Payments & Billing');
assert.deepStrictEqual(context.COMMERCE_ANALYTICS,['commerce-overview','Analytics','/admin/commerce'],'The old Commerce analytics tuple remains exported for compatibility without becoming an upper tab');
for(const active of ['branding','discounts','finance','activity','provider-mappings','server-migrations','configuration-transfer']){
  assert.deepStrictEqual(context.subPages(active),[],`${active} must not generate a secondary upper-tab row`);
  assert.strictEqual(context.subActiveKey(active),null,`${active} must not maintain a secondary active-tab state`);
}

// Former subsection destinations remain discoverable as ordinary tools inside
// their main owner rather than disappearing when the secondary row is retired.
assert.deepStrictEqual(
  labels(context.ownedToolPages('settings-general')),
  ['Branding','Support & legal'],
  'General must own Branding and Support & legal as in-page tools'
);
assert.deepStrictEqual(
  labels(context.ownedToolPages('orders')),
  ['Commerce analytics','Discounts','Affiliates','Finance'],
  'Orders & Growth must own analytics, discounts, affiliates and Finance as in-page tools'
);
assert.deepStrictEqual(
  labels(context.ownedToolPages('payments')),
  ['Billing','Provider mappings','Payment risk'],
  'Payments & Billing must own billing, mappings and risk as in-page tools'
);
assert(labels(context.ownedToolPages('activity')).includes('Free-user inactivity rules'),'Playback must expose inactivity rules inside the main Playback area');
assert.deepStrictEqual(context.ownedToolPages('branding'),[],'A specialist child page must not repeat its parent tool directory');
assert.deepStrictEqual(context.ownedToolPages('dashboard'),[],'Dashboard must not repeat Needs Attention below the preferred Current/Related row');
assert(!labels(context.ownedToolPages('users')).includes('Jellyfin password support'),'Customer-specific credential support must remain contextual rather than becoming a generic Customers tool');

const brandingCrumb=context.breadcrumb('branding');
assert(brandingCrumb.includes('<a href="/admin/settings?section=general">General</a>'),'Branding breadcrumb must provide an in-product path back to General');
assert(brandingCrumb.includes('<strong>Branding</strong>'),'Branding breadcrumb must identify the current specialist page');
const discountCrumb=context.breadcrumb('discounts');
assert(discountCrumb.includes('<a href="/admin/plans">Commerce</a>'),'Commerce breadcrumb must use the normal Commerce landing page rather than the demoted Analytics child');
assert(discountCrumb.includes('<a href="/admin/commerce/orders">Orders &amp; Growth</a>'),'Commerce child breadcrumb must link back to its owning main tab');
assert(discountCrumb.includes('<strong>Discounts</strong>'),'Commerce child breadcrumb must identify the specialist page');
const financeCrumb=context.breadcrumb('finance');
assert(financeCrumb.includes('<a href="/admin/commerce/orders">Orders &amp; Growth</a>'),'Finance breadcrumb must link back to Orders & Growth');
assert(financeCrumb.includes('<strong>Finance</strong>'),'Finance breadcrumb must identify the specialist page');

const oneRow=context.render('branding');
assert(oneRow.includes('workflowCardGrid coherenceSectionTabs'),'The single upper row must use the preferred compact Current/Related visual language');
assert(oneRow.includes('workflowCardEyebrow">Current'),'The active main tab must be labelled Current');
assert(oneRow.includes('workflowCardEyebrow">Related'),'Sibling main tabs must be labelled Related');
assert(!oneRow.includes('coherenceSubTabs'),'The server renderer must never emit a secondary upper row');
assert.strictEqual((oneRow.match(/<nav\b/g)||[]).length,1,'Context navigation must render at most one upper nav element');

// Full modern documents keep one main row, strip legacy workflow navigators,
// and append the former secondary destinations as ordinary page content.
const rendered=html.layout({
  active:'payments',
  title:'Payments',
  subtitle:'Payment provider health',
  body:'<section id="navigation-coherence-sentinel">sentinel</section>'
});
assert(rendered.includes('aria-label="Commerce sections"'),'Commerce must render its one main section row server-side');
assert.strictEqual((rendered.match(/class="workflowCardGrid coherenceSectionTabs"/g)||[]).length,1,'A modern page must contain exactly one primary contextual row');
assert(!rendered.includes('class="coherenceSubTabs"'),'Modern documents must not contain a secondary coherence row');
assert(!rendered.includes('class="workflowCardGrid operatorTabs"'),'Legacy server workflow navigators must be removed from the final document');
assert(rendered.indexOf('coherenceSectionTabs')<rendered.indexOf('navigation-coherence-sentinel'),'The one contextual row must appear before page content');
assert(rendered.includes('class="coherenceOwnedTools"'),'Former payment subtabs must become in-page tools');
assert(rendered.includes('href="/admin/provider-mappings"')&&rendered.includes('href="/admin/billing"')&&rendered.includes('href="/admin/payments/risk-policy"'),'Payment specialist destinations must remain reachable from the Payments main page');
assert(/topBreadcrumb[\s\S]*<a href="\/admin\/plans">Commerce<\/a>/.test(rendered),'Top breadcrumb must expose Commerce ancestry through its main landing page');

// Finance values must stay conservative: unknown fees are null, not zero, and
// dated expense changes/refunds preserve historical accounting semantics.
assert.strictEqual(paymentFinancials.integerOrNull(null),null,'Unknown provider fees must not be converted to zero');
assert.strictEqual(paymentFinancials.integerOrNull(undefined),null,'Missing provider fees must stay unknown');
assert.strictEqual(paymentFinancials.integerOrNull('0'),0,'A genuine zero fee must remain representable');
assert.strictEqual(finance.moneyToMinor('12.34'),1234,'Expense amounts must be stored in integer minor units');
assert.strictEqual(finance.defaultRenewal('2026-01-31','monthly'),'2026-02-28','Monthly renewal dates must clamp safely at month end');
assert.strictEqual(finance.defaultRenewal('2024-02-29','yearly'),'2025-02-28','Yearly renewal dates must clamp leap-day subscriptions safely');
const refundRows=finance.normalizedAdverseRows([
  {provider:'stripe',incident_type:'refund',provider_case_id:'ch_test',amount_minor:300,currency:'GBP',created_at:'2026-01-02T00:00:00Z'},
  {provider:'stripe',incident_type:'refund',provider_case_id:'ch_test',amount_minor:500,currency:'GBP',created_at:'2026-01-03T00:00:00Z'}
]);
assert.deepStrictEqual(refundRows.map(row=>row.effective_minor),[300,200],'Cumulative Stripe partial refunds must only deduct the incremental reversal');

const coreSource=read('src/platform/admin-html-core.js');
assert(coreSource.includes('renderOwnedTools(options.active)'),'Shared admin rendering must append owner tools as page content');
assert(coreSource.includes('function removeSecondaryWorkflowNavigation'),'Shared admin rendering must enforce removal of legacy server workflow rows');
assert(coreSource.includes('workflowCardGrid operatorTabs'),'The server cleanup must target the legacy workflow-card navigation signature');
const financeSource=read('src/platform/admin-finance.js');
assert(financeSource.includes("active:'finance'"),'Finance must render through the standard admin layout');
assert(financeSource.includes('/admin/finance/fees/refresh'),'Finance must expose an explicit merchant-fee refresh action');
assert(financeSource.includes('effective_from:today()'),'Expense changes must default to a new dated version instead of rewriting history');

const fallback=read('public/js/admin-navigation-coherence.js');
assert(fallback.includes("if(!document.querySelector('.coherenceSectionTabs'))"),'Legacy navigation enhancer must remain fallback-only');
assert(fallback.includes("['Servers','/admin/servers']")&&fallback.includes("['Playback','/admin/activity']"),'Legacy Jellyfin pages must receive the same one main row');
assert(!fallback.includes("['Policy settings','/admin/activity#playback-policy']"),'Playback policy must stay in the Playback page instead of returning as an upper subtab');
assert(fallback.includes('function enforceSingleUpperNavigation()'),'Client enhancement must enforce the one-row rule for legacy/client-inserted navigation');
assert(fallback.includes('appendOwnedTools(content,demotedLinks)'),'Client enhancement must preserve demoted destinations as ordinary in-page tools');

const css=read('public/css/admin-navigation-coherence.css');
assert(css.includes('.coherenceSectionTabs.workflowCardGrid'),'The one main row must use the preferred compact workflow-card presentation');
assert(css.includes('.coherenceOwnedToolsGrid'),'Former secondary destinations must have a dedicated non-sticky content layout');
assert(css.includes('.coherenceSubTabs,.pageHeader + .operatorTabs:not(.coherenceSectionTabs){display:none!important}'),'CSS must fail safe by never displaying stacked legacy upper rows');
assert(/settingsCommerceGrid\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/.test(css),'Settings-style configuration cards should remain three-up where practical');
assert(read('public/css/admin-capability.css').includes("@import url('/css/admin-finance.css')"),'Finance styles must be loaded by the shared admin capability bundle');

console.log('admin navigation coherence smoke: ok');
