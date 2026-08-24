'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const context=require('../src/platform/admin-context-navigation');
const html=require('../src/platform/admin-html-core');

const keys=rows=>rows.map(row=>row[0]);
const labels=rows=>rows.map(row=>row[1]);

// Settings keeps one stable section row while General-owned child pages expose
// the same General / Branding / Support & legal sibling row.
assert.deepStrictEqual(
  keys(context.sectionPages('branding')),
  ['settings-general','settings-security','settings-integrations','settings-commerce','system'],
  'Settings child pages must preserve the complete Settings section row'
);
assert.strictEqual(context.sectionActiveKey('branding'),'settings-general','Branding must remain owned by Settings → General');
assert.deepStrictEqual(
  keys(context.subPages('branding')),
  ['settings-general','branding','support-policy'],
  'General, Branding and Support & legal must remain sibling pages'
);
const brandingCrumb=context.breadcrumb('branding');
assert(brandingCrumb.includes('<a href="/admin/settings?section=general">General</a>'),'Branding breadcrumb must provide an in-product path back to General');
assert(brandingCrumb.includes('<strong>Branding</strong>'),'Branding breadcrumb must identify the current page');

// Commerce has one canonical section row. Discounts/Affiliates remain children
// of Orders & Growth rather than becoming a new top-level navigation model.
assert.deepStrictEqual(
  keys(context.sectionPages('discounts')),
  ['plans','orders','payments','commerce-overview'],
  'Commerce must keep one stable Plans / Orders / Payments / Analytics section row'
);
assert.strictEqual(context.sectionActiveKey('discounts'),'orders','Discounts must remain owned by Orders & Growth');
assert.deepStrictEqual(
  labels(context.subPages('discounts')),
  ['Orders & Growth','Commerce analytics','Discounts','Affiliates'],
  'Orders & Growth child navigation must remain stable across its sibling pages'
);
const discountCrumb=context.breadcrumb('discounts');
assert(discountCrumb.includes('<a href="/admin/commerce/orders">Orders &amp; Growth</a>'),'Commerce child breadcrumb must link back to its canonical parent');
assert(discountCrumb.includes('<strong>Discounts</strong>'),'Commerce child breadcrumb must identify the current page');

// Jellyfin Playback keeps the navigation required to move between live state
// and policy without relying on browser Back or a disappearing page-only tab.
assert.deepStrictEqual(
  context.subPages('activity'),
  [
    ['activity-live','Live playback','/admin/activity'],
    ['activity-policy','Policy settings','/admin/activity#playback-policy']
  ],
  'Playback must expose stable Live playback and Policy settings siblings'
);
assert.strictEqual(context.subActiveKey('activity'),'activity-live','Playback defaults to Live playback');
assert.strictEqual(context.subActiveKey('activity','#playback-policy'),'activity-policy','Playback policy anchor must activate Policy settings');

// Modern pages must receive the hierarchy in server HTML, with ancestry links,
// and must not retain the superseded card-based navigation for the same level.
const rendered=html.layout({
  active:'payments',
  title:'Payments',
  subtitle:'Payment provider health',
  body:'<section id="navigation-coherence-sentinel">sentinel</section>'
});
assert(rendered.includes('aria-label="Commerce sections"'),'Modern Commerce pages must render the persistent section row server-side');
assert(rendered.includes('aria-label="Payments &amp; Billing pages"'),'Payments must render its persistent subsection row server-side');
assert(rendered.indexOf('coherenceSectionTabs')<rendered.indexOf('navigation-coherence-sentinel'),'Persistent navigation must appear before page content');
assert(!rendered.includes('aria-label="Payments and billing control room"'),'Superseded Payments workflow-card navigation must not render beside the new hierarchy');
assert(/topBreadcrumb[\s\S]*<a href="\/admin\/commerce">Commerce<\/a>/.test(rendered),'Top breadcrumb must expose clickable Commerce ancestry');

const fallback=read('public/js/admin-navigation-coherence.js');
assert(fallback.includes("if(!document.querySelector('.coherenceSectionTabs'))"),'Legacy navigation enhancer must remain fallback-only');
assert(fallback.includes("['Live playback','/admin/activity']")&&fallback.includes("['Policy settings','/admin/activity#playback-policy']"),'Legacy Playback pages must use the same stable sibling destinations');

const css=read('public/css/admin-navigation-coherence.css');
assert(css.includes('.coherenceSectionTabs')&&css.includes('.coherenceSubTabs'),'Persistent section and subsection rows must share one visual system');
assert(!css.includes('body:has(.coherenceSubTabs) .workflowCardGrid.operatorTabs'),'Navigation CSS must not hide unrelated page-local workflow cards');
assert(/settingsCommerceGrid\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/.test(css),'Settings-style configuration cards should remain three-up where practical');

console.log('admin navigation coherence smoke: ok');
