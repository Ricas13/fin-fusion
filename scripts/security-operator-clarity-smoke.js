'use strict';

const fs=require('fs');
const path=require('path');
const stepUp=require('../src/auth/admin-step-up');
const root=path.join(__dirname,'..');
function text(file){return fs.readFileSync(path.join(root,file),'utf8');}
function assert(condition,message){if(!condition)throw new Error(message);}
function post(pathname){return stepUp.sensitive({method:'POST',path:pathname});}

for(const route of [
    '/admin/users/11111111-1111-1111-1111-111111111111/library-overrides',
    '/admin/users/11111111-1111-1111-1111-111111111111/profile',
    '/admin/provisioning/migrations/11111111-1111-1111-1111-111111111111/apply',
    '/admin/provisioning/migrations/11111111-1111-1111-1111-111111111111/rollback',
    '/admin/servers/11111111-1111-1111-1111-111111111111'
])assert(post(route),`High-impact admin route is missing step-up coverage: ${route}`);
assert(!post('/admin/server-migrations/legacy/apply'),'Stale server-migrations URL unexpectedly remains security-significant.');

const paypal=text('src/payments/paypal.js');
assert(/immutableSubscriptionContract/.test(paypal),'PayPal activation must resolve an immutable subscription contract.');
assert(/activation was refused without an immutable local contract/.test(paypal),'PayPal subscription activation must fail closed without a local contract.');
const bulk=text('src/platform/bulk-operations.js');
assert(/capacityLock\.withCapacityLock\(resellerId/.test(bulk),'Bulk reseller assignment must share the reseller capacity advisory lock.');
const capacity=text('src/resellers/capacity-lock.js');
assert(/new Pool\(/.test(capacity)&&/connectionTimeoutMillis/.test(capacity),'Reseller capacity locks must use a bounded dedicated connection pool.');
const maintenance=text('src/security/maintenance-lock.js');
assert(/connectionTimeoutMillis/.test(maintenance),'Maintenance lock pool must have a connection acquisition timeout.');
const servers=text('src/platform/admin-servers.js');
assert(/outbound\.safeFetch\(`\$\{baseUrl\}\/System\/Info`/.test(servers),'Jellyfin credential probes must use the pinned outbound URL policy.');
const serverForm=text('views/admin/server-form.ejs');
assert(/include\('_nav',\{siteName,activeNav:'servers'\}\)/.test(serverForm),'Server form must render the canonical admin navigation.');
const csp=text('scripts/csp-inline-audit.js');
assert(/Scan the complete source/.test(csp)&&!/lines\.forEach/.test(csp),'CSP static audit must remain multiline-aware.');

// Historical migrations intentionally include duplicate numeric prefixes and
// are keyed by complete filename. Freeze that history, but reject any new
// duplicate numeric prefix from 067 onward.
const migrations=fs.readdirSync(path.join(root,'db','migrations')).filter(name=>/^\d{3}.*\.sql$/.test(name));
const groups=new Map();
for(const name of migrations){const prefix=Number(name.slice(0,3));if(prefix<67)continue;const list=groups.get(prefix)||[];list.push(name);groups.set(prefix,list);}
for(const[prefix,names]of groups)assert(names.length===1,`Migration prefix ${String(prefix).padStart(3,'0')} is reused: ${names.join(', ')}`);

console.log('Security/operator clarity static regression checks passed.');