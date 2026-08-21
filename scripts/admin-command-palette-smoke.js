'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const shell=read('src/platform/admin-html-core.js');
for(const token of ['data-command-palette-open','aria-haspopup="dialog"','role="dialog"','role="combobox"','role="listbox"','adminCommandResults','/js/admin-command-palette.js'])assert(shell.includes(token),`admin shell missing command palette contract: ${token}`);
assert(shell.includes("action=\"\\/admin\\/search\""),'command palette enhancement must replace the existing canonical search launcher rather than introduce another search form');

const script=read('public/js/admin-command-palette.js');
for(const token of ["event.metaKey||event.ctrlKey","event.key.toLowerCase()==='k'","event.key==='Escape'","event.key==='ArrowDown'","event.key==='ArrowUp'","event.key==='Enter'",'a.adminTab[href]','/admin/users/new','/admin/jellyfin-import','/admin/servers/new','/admin/search?q=','aria-activedescendant','window.location.assign'])assert(script.includes(token),`command palette behavior missing: ${token}`);
assert(script.includes("href==='/logout'||link.target==='_blank'"),'command discovery must exclude sign-out and external account actions');
assert(script.includes('.textContent=command.label')&&script.includes('.textContent=command.group'),'dynamic command labels must be written as text, not interpolated into HTML');
assert(!script.includes('fetch('),'command palette must reuse canonical navigation/search instead of creating a second live-search API');

const capability=read('public/css/admin-capability.css');
assert(capability.includes("@import url('/css/admin-command-palette.css')"),'admin shell must load command palette styles');
const css=read('public/css/admin-command-palette.css');
for(const token of ['.adminCommandBackdrop[hidden]','min-height:44px','prefers-reduced-motion','.adminCommandOption[aria-selected="true"]'])assert(css.includes(token),`command palette CSS missing: ${token}`);

const search=read('src/platform/admin-search.js');
assert(search.includes("r.get('/admin/search'"),'free-text command palette searches must land on the existing canonical admin search route');
assert(search.includes('customers:customers.rows,servers:servers.rows,plans:plans.rows,billing:billing.rows'),'canonical search must remain the single record-search backend');

console.log('admin command palette smoke: ok');
