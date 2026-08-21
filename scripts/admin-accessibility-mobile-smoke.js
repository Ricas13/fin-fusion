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

const capability=read('public/css/admin-capability.css');
assert(capability.includes("@import url('/css/admin-accessibility-mobile.css')"),'admin shell must load accessibility/mobile layer');
const css=read('public/css/admin-accessibility-mobile.css');
for(const contract of ['.srOnly',':focus-visible','min-height:44px','prefers-reduced-motion','td[data-label=""]'])assert(css.includes(contract),`accessibility/mobile CSS missing ${contract}`);
assert(css.includes('.profileMeta,.summaryLabel,.summarySub'),'legacy customer metadata must use the readable shared override');

const customers=read('src/platform/admin-customers-list.js');
for(const wording of ['Access sync','Custom access','Customer sign-in disabled','Customer health','customer sign-ins enabled','Customers who still need to verify their account'])assert(customers.includes(wording),`customers UI missing plain-language wording: ${wording}`);
for(const jargon of ['data-label="Reconciliation"','<th>Reconciliation</th>','<label>Reconciliation status</label>','<label>Admin override</label>','portal logins enabled'])assert(!customers.includes(jargon),`customers UI still exposes jargon: ${jargon}`);
for(const semantic of ['for="customerFilterProduct"','for="customerFilterSync"','aria-label="Select ${esc(customerName)}"','<caption class="srOnly">Customer results</caption>','aria-label="Customer pages"'])assert(customers.includes(semantic),`customers UI missing accessible structure: ${semantic}`);

// The UX rename must not create parallel state or break backwards-compatible
// query values used by existing links, exports and backend filters.
for(const internal of ['name="reconciliationStatus"','name="hasOverride"','portal_disabled','filters.reconciliationStatus','filters.hasOverride'])assert(customers.includes(internal),`customer filter contract changed unexpectedly: ${internal}`);

console.log('admin accessibility/mobile terminology smoke: ok');
