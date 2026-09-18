'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const shell=read('src/platform/admin-html-core.js');
for(const token of ['data-command-palette-open','aria-haspopup="dialog"','role="dialog"','role="combobox"','role="listbox"','adminCommandResults','/js/admin-command-palette.js'])assert(shell.includes(token),`admin shell missing command palette contract: ${token}`);
assert(shell.includes("action=\"\\/admin\\/search\""),'command palette enhancement must replace the existing canonical search launcher rather than introduce another search form');


const commandIndex=require('../src/platform/admin-command-index');
const indexed=commandIndex.all();
assert(commandIndex.markup().includes('data-admin-command-seed'),'canonical command index must render CSP-safe seed elements');
assert(shell.includes('commandIndex.markup()'),'admin shell must render the canonical command index without inline JavaScript');
for(const [label,href] of [['Billing','/admin/billing'],['Free Server inactivity policy','/admin/servers'],['Transactional email / SMTP','/admin/notifications/email'],['Provider transaction ledger','/admin/payments/transactions'],['Add customer','/admin/users/new'],['Add Jellyfin server','/admin/servers/new'],['Import from Jellyfin','/admin/jellyfin-import'],['Needs attention','/admin/attention'],['Search','/admin/search']]){
  assert(indexed.some(item=>item.label===label&&item.href===href),`canonical command index missing ${label} → ${href}`);
}

const script=read('public/js/admin-command-palette.js');
for(const token of ["event.metaKey||event.ctrlKey","event.key.toLowerCase()==='k'","event.key==='Escape'","event.key==='ArrowDown'","event.key==='ArrowUp'","event.key==='Enter'",'a.adminTab[href]','/admin/search?q=','aria-activedescendant','window.location.assign'])assert(script.includes(token),`command palette behavior missing: ${token}`);
assert(script.includes("href==='/logout'||link.target==='_blank'"),'command discovery must exclude sign-out and external account actions');
assert(script.includes("document.querySelectorAll('[data-admin-command-seed]')"),'command palette must seed itself from the canonical CSP-safe server-rendered admin index');
assert(script.includes('.textContent=command.label')&&script.includes('.textContent=command.group'),'dynamic command labels must be written as text, not interpolated into HTML');
assert(!script.includes('fetch('),'command palette must reuse canonical navigation/search instead of creating a second live-search API');
assert(!script.includes("{label:'Add customer'")&&!script.includes('Import Jellyfin users'),'special command actions must not be duplicated in client-side state');

const capability=read('public/css/admin-capability.css');
assert(capability.includes("@import url('/css/admin-command-palette.css')"),'admin shell must load command palette styles');
const css=read('public/css/admin-command-palette.css');
for(const token of ['.adminCommandBackdrop[hidden]','min-height:44px','prefers-reduced-motion','.adminCommandOption[aria-selected="true"]'])assert(css.includes(token),`command palette CSS missing: ${token}`);

const search=read('src/platform/admin-search.js');
assert(search.includes("r.get('/admin/search'"),'free-text command palette searches must land on the existing canonical admin search route');
assert(search.includes('customers:customers.rows,servers:servers.rows,plans:plans.rows,billing:billing.rows'),'canonical search must remain the single record-search backend');

console.log('admin command palette smoke: ok');
