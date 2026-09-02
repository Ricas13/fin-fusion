'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const shell=read('src/platform/admin-html-core-base.js');
assert(shell.includes('<html lang="en">'),'admin shell must declare document language');
assert(shell.includes('class="skipLink" href="#admin-main"'),'admin shell must expose a keyboard skip link');
assert(shell.includes('id="admin-main" tabindex="-1"'),'main content must be a focusable skip-link target');
assert(shell.includes('aria-current="page"'),'active admin navigation must expose aria-current');
assert(shell.includes('aria-live="polite"'),'operator status updates must be announced politely');
assert(shell.includes('for="adminQuickFindInput"'),'quick find must have a real label association');
assert(shell.includes('Help & docs'),'help action should use a plain-language label');
assert(shell.includes('data-section="${esc(current.group.key)}"'),'canonical pages must publish their section hue on body');
assert(shell.includes('@media(max-width:820px)'),'canonical shell must use the token-system mobile breakpoint');
for(const contract of ['.adminMobileNavToggle','transform:translateX(-100%)','.adminHeader.mobileNavOpen','width:min(86vw,320px)','body.mobileNavLocked']){
  assert(shell.includes(contract),`canonical mobile drawer CSS missing ${contract}`);
}
assert(!shell.includes('adminSubTab'),'canonical shell must not render or style a third navigation level');
assert(!shell.includes('--header-actions-h'),'canonical shell must not reserve measured account-menu height');

const progressiveShell=read('src/platform/admin-html-core.js');
assert(progressiveShell.includes('/js/admin-safety-confirmations.js'),'admin shell must load shared safety confirmations');
assert(progressiveShell.includes('/js/admin-rail.js'),'admin shell must load the unified rail/drawer controller');
assert(!progressiveShell.includes('/js/admin-sidebar-nav.js'),'retired sidebar controller must not be loaded alongside the unified rail');

const legacyNav=read('views/admin/_nav.ejs');
const navRegistry=require('../src/platform/admin-nav');
assert(legacyNav.includes("require(process.cwd() + '/src/platform/admin-html-core-base')")&&legacyNav.includes('adminCore.header(activeNav, siteName)'),'legacy EJS screens must render the exact canonical rail markup');
assert(!legacyNav.includes('iconPaths')&&!legacyNav.includes('adminSubTab'),'legacy EJS rail must not duplicate icons or third-level navigation');
assert.deepStrictEqual(navRegistry.childPages('activity'),[],'Playback must not render third-level rail children');
assert(navRegistry.settingsFor('activity').some(page=>page[0]==='inactivity-policy'),'Playback inactivity rules must remain discoverable as a parent-owned setting');
assert(navRegistry.relatedPages('servers').some(page=>page[0]==='libraries'),'Libraries must remain reachable from its parent without occupying the rail');

const rail=read('public/js/admin-rail.js');
for(const contract of [
  'closeOthers(section)',
  'other.open=false',
  "adminRailOpenSection",
  "window.matchMedia(MOBILE_QUERY)",
  "data-admin-mobile-nav-toggle",
  'adminMobileNavBackdrop',
  'mobileNavOpen',
  'aria-expanded',
  "event.key==='Escape'",
  "event.key!=='Tab'",
  'getClientRects().length>0',
  "event.target.closest('a[href]')"
]) assert(rail.includes(contract),`unified rail behavior missing ${contract}`);
assert(rail.includes("const MOBILE_QUERY='(max-width:820px)'"),'rail behavior must share the 820px mobile breakpoint');

const navCoherence=read('public/js/admin-navigation-coherence.js');
assert(!navCoherence.includes('installMobileAdminDrawer'),'navigation coherence enhancer must not own a second mobile drawer');
assert(!fs.existsSync(path.join(root,'public/css/admin-mobile-drawer-fix.css')),'obsolete mobile drawer correction stylesheet must be deleted');

const capability=read('public/css/admin-capability.css');
assert(capability.includes("@import url('/css/admin-accessibility-mobile.css')"),'admin shell must load accessibility/mobile layer');
assert(capability.includes("@import url('/css/admin-responsive-tables.css')"),'admin shell must load shared responsive-table layer');
assert(!capability.includes('admin-mobile-drawer-fix.css'),'capability layer must not import the retired drawer correction file');
const css=read('public/css/admin-accessibility-mobile.css');
for(const contract of ['.srOnly',':focus-visible','min-height:var(--pitch)','prefers-reduced-motion','td[data-label=""]'])assert(css.includes(contract),`accessibility/mobile CSS missing ${contract}`);
assert(css.includes('.profileMeta,.summaryLabel,.summarySub'),'legacy customer metadata must use the readable shared override');
assert(!css.includes('.adminHeader.mobileNavOpen'),'accessibility layer must not reimplement canonical drawer geometry');

const responsiveCss=read('public/css/admin-responsive-tables.css');
for(const contract of ['@media(max-width:1100px)','.responsiveTable thead','.responsiveTable tbody','.responsiveTable td::before','content:attr(data-label)','word-break:normal','grid-template-columns:minmax(100px,30%) minmax(0,1fr)','.attentionBulkBar{grid-template-columns:1fr!important}'])assert(responsiveCss.includes(contract),`responsive table CSS missing ${contract}`);
assert(responsiveCss.includes('min-width:0!important'),'responsive tables must clear legacy minimum widths before they become record cards');
assert(responsiveCss.includes('@media(max-width:600px)'),'phone-width responsive tables must have a dedicated compact layout');
const billing=read('src/platform/admin-billing.js');
for(const contract of ['responsiveTable billingTable','responsiveTable discoveryTable','responsiveTable eventTable','data-label=\"Customer\"','data-label=\"Premium user\"','data-label=\"Provider subscription\"','@media(max-width:600px)'])assert(billing.includes(contract),`Billing mobile contract missing ${contract}`);
const transactions=read('src/platform/admin-transactions.js');
for(const contract of ['responsiveTable transactionTable','data-label=\"When\"','data-label=\"Provider / type\"','data-label=\"Customer\"','data-label=\"Provider IDs\"','@media(max-width:600px)'])assert(transactions.includes(contract),`Transactions mobile contract missing ${contract}`);
const attention=read('src/platform/admin-attention.js');
assert(attention.includes('class="dataTable responsiveTable attentionTable"'),'Needs Attention must use the shared responsive-table contract');
for(const label of ['data-label="Severity"','data-label="Area"','data-label="Issue"','data-label="Owner"','data-label="Workflow"'])assert(attention.includes(label),`Needs Attention responsive table missing ${label}`);

const customers=read('src/platform/admin-customers-list.js');
for(const wording of ['Access sync','Custom access','Customer sign-in disabled','Customer health','customer sign-ins enabled','Customers who still need to verify their account'])assert(customers.includes(wording),`customers UI missing plain-language wording: ${wording}`);
for(const jargon of ['data-label="Reconciliation"','<th>Reconciliation</th>','<label>Reconciliation status</label>','<label>Admin override</label>','portal logins enabled'])assert(!customers.includes(jargon),`customers UI still exposes jargon: ${jargon}`);
for(const semantic of ['for="customerFilterProduct"','for="customerFilterSync"','aria-label="Select ${esc(customerName)}"','<caption class="srOnly">Customer results</caption>','aria-label="Customer pages"'])assert(customers.includes(semantic),`customers UI missing accessible structure: ${semantic}`);

// The UX rename must not create parallel state or break backwards-compatible
// query values used by existing links, exports and backend filters.
for(const internal of ['name="reconciliationStatus"','name="hasOverride"','portal_disabled','filters.reconciliationStatus','filters.hasOverride'])assert(customers.includes(internal),`customer filter contract changed unexpectedly: ${internal}`);

const controls=read('src/platform/admin-setting-controls.js');
assert(controls.includes('data-confirm-when-checked'),'setting controls must expose shared destructive-choice confirmation metadata');
const safetyScript=read('public/js/admin-safety-confirmations.js');
assert(safetyScript.includes('[data-confirm-when-checked]:checked'),'shared safety script must only confirm a destructive choice when selected');
assert(safetyScript.includes('window.confirm(message)'),'shared safety script must require explicit confirmation');
const abuse=read('src/platform/admin-abuse-protection.js');
assert(abuse.includes("confirmWhenChecked:'Clear the stored Cloudflare Turnstile secret?"),'secret clearing must opt into the shared confirmation contract');
assert(abuse.includes('for="turnstileSiteKey"')&&abuse.includes('for="turnstileSecret"'),'Turnstile credentials must have associated labels');

console.log('admin accessibility/mobile terminology smoke: ok');
