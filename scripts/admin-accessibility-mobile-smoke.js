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
for(const contract of ['id="adminNavigation" data-admin-navigation','data-admin-nav-open','aria-controls="adminNavigation"','aria-expanded="false"','data-admin-nav-close','adminNavBackdrop'])assert(shell.includes(contract),`mobile admin shell missing ${contract}`);
const progressiveShell=read('src/platform/admin-html-core.js');
assert(progressiveShell.includes('/js/admin-safety-confirmations.js'),'admin shell must load shared safety confirmations');
assert(progressiveShell.includes('/js/admin-sidebar-nav.js'),'admin shell must load shared sidebar navigation behavior');

const sidebar=read('public/js/admin-sidebar-nav.js');
assert(sidebar.includes('closeOthers(section)')&&sidebar.includes('other.open=false'),'opening one admin navigation group must collapse the other groups');
assert(sidebar.includes("section.querySelector('.navSectionPages .adminTab[href]')"),'parent navigation must resolve the first submenu destination');
assert(sidebar.includes('event.preventDefault()')&&sidebar.includes('window.location.assign(first.href)'),'desktop parent clicks must expand the group and open its first submenu page');
assert(sidebar.includes("window.matchMedia('(max-width:860px)')"),'sidebar behavior must have an explicit mobile breakpoint');
for(const contract of ['function openDrawer()','function closeDrawer(','adminNavOpen',"drawer.setAttribute('inert','')","event.key==='Escape'","event.target.closest('.adminTab[href]')"])assert(sidebar.includes(contract),`mobile drawer behavior missing ${contract}`);
assert(sidebar.includes('if(mobileQuery.matches)return;'),'mobile group labels must remain disclosure controls instead of forcing navigation');

const capability=read('public/css/admin-capability.css');
assert(capability.includes("@import url('/css/admin-accessibility-mobile.css')"),'admin shell must load accessibility/mobile layer');
const css=read('public/css/admin-accessibility-mobile.css');
for(const contract of ['.srOnly',':focus-visible','min-height:44px','prefers-reduced-motion','td[data-label=""]'])assert(css.includes(contract),`accessibility/mobile CSS missing ${contract}`);
for(const contract of ['body.adminNavOpen','width:min(86vw,320px)!important','transform:translateX(-105%)','.adminHeader.isMobileOpen','.adminMobileNavButton','.adminNavBackdrop','.navSectionLabel{display:flex!important'])assert(css.includes(contract),`mobile drawer CSS missing ${contract}`);
assert(css.includes('.profileMeta,.summaryLabel,.summarySub'),'legacy customer metadata must use the readable shared override');
const refinement=read('public/css/admin-visual-refinement.css');
assert(refinement.includes('off-canvas drawer'),'visual refinement layer must preserve the drawer navigation model');
assert(!refinement.includes('existing horizontal navigation'),'no later CSS layer may restore the unusable horizontal mobile sidebar');

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
