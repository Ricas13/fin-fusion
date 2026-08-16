'use strict';

const fs=require('fs');
const path=require('path');
const stepUp=require('../src/auth/admin-step-up');
const stremio=require('../src/stremio/foundation');
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
assert(/reverseReferralForDirectIdentity/.test(paypal),'PayPal reversals must revisit already-rewarded referrals.');
const stripe=text('src/payments/stripe.js');
assert(/reverseReferralForDirectIdentity/.test(stripe),'Stripe reversals must revisit already-rewarded referrals.');
const referrals=text('src/referrals.js');
assert(/revisitRewardAfterAdversePayment/.test(referrals)&&/referral_reward_reversals/.test(referrals),'Referral rewards must support idempotent unused-day reversal.');

const bulk=text('src/platform/bulk-operations.js');
assert(/capacityLock\.withCapacityLock\(resellerId/.test(bulk),'Bulk reseller assignment must share the reseller capacity advisory lock.');
const capacity=text('src/resellers/capacity-lock.js');
assert(/new Pool\(/.test(capacity)&&/connectionTimeoutMillis/.test(capacity),'Reseller capacity locks must use a bounded dedicated connection pool.');
const maintenance=text('src/security/maintenance-lock.js');
assert(/connectionTimeoutMillis/.test(maintenance),'Maintenance lock pool must have a connection acquisition timeout.');

const pending=text('src/security/pending-registration.js');
const publicAuth=text('src/platform/customer-public-auth.js');
const jobs=text('src/automation/jobs.js');
assert(/pending_registrations/.test(pending)&&/password_hash/.test(pending)&&/token_hash/.test(pending),'Verified public registrations must be staged with hashed credentials/tokens.');
assert(/pendingRegistrations\.begin/.test(publicAuth)&&/verify-registration/.test(publicAuth)&&/pendingRegistrations\.consume/.test(publicAuth),'Public verification must create the real customer only after consuming a pending registration.');
assert(/pending_registration_cleanup/.test(jobs),'Expired pending registrations must be an automation job.');

const emailChange=text('src/security/customer-email-change.js');
assert(/notifyOldAddress/.test(emailChange)&&/email_change_security_completed/.test(emailChange),'Email changes must notify the old address out of band.');
const servers=text('src/platform/admin-servers.js');
assert(/outbound\.safeFetch\(`\$\{baseUrl\}\/System\/Info`/.test(servers),'Jellyfin credential probes must use the pinned outbound URL policy.');
const serverForm=text('views/admin/server-form.ejs');
assert(/include\('_nav',\{siteName,activeNav:'servers'\}\)/.test(serverForm),'Server form must render the canonical admin navigation.');
const csp=text('scripts/csp-inline-audit.js');
assert(/Scan the complete source/.test(csp)&&!/lines\.forEach/.test(csp),'CSP static audit must remain multiline-aware.');

const support=text('src/platform/support-policy.js'),help=text('src/platform/public-help.js');
assert(/docsUrl/.test(support)&&/Help & guides/.test(help),'Managed documentation URL must be discoverable from public Help.');
const nav=text('src/platform/admin-nav.js'),settings=text('src/platform/admin-original-settings.js');
for(const label of ['General','Branding','Commerce','Integrations','Security','Operations','Backups','Advanced'])assert(nav.includes(`'${label}'`),`Settings navigation is missing ${label}.`);
assert(/pendingRegistrations\.stats/.test(settings)&&/Registration & verification/.test(settings),'Security settings must expose staged-registration state.');

const oldRuntime=process.env.STREMIO_RUNTIME_ENABLED;delete process.env.STREMIO_RUNTIME_ENABLED;
assert(stremio.assertAcquirable({service_type:'jellyfin'}).service_type==='jellyfin','Jellyfin acquisition must remain available while Stremio runtime is disabled.');
let blocked=false;try{stremio.assertAcquirable({service_type:'stremio'});}catch(error){blocked=/not available/.test(error.message);}assert(blocked,'Stremio acquisition must fail closed before the runtime is enabled.');
if(oldRuntime===undefined)delete process.env.STREMIO_RUNTIME_ENABLED;else process.env.STREMIO_RUNTIME_ENABLED=oldRuntime;
const lifecycle=text('src/payments/lifecycle.js');
assert(/stremio\.assertAcquirable/.test(lifecycle),'Canonical paid/free/trial lifecycle must enforce the Stremio runtime gate.');

// Policy Drift remains load-bearing but its former tuning form is deliberately
// gone from the operator page; cadence values are now informational defaults.
const driftAdmin=text('src/platform/admin-drift.js');
assert(/Audit cadence/.test(driftAdmin)&&!/drift\/settings/.test(driftAdmin),'Policy Drift low-level tuning must stay out of the normal operator form.');

// Historical migrations intentionally include duplicate numeric prefixes and
// are keyed by complete filename. Freeze that history, but reject any new
// duplicate numeric prefix from 067 onward.
const migrations=fs.readdirSync(path.join(root,'db','migrations')).filter(name=>/^\d{3}.*\.sql$/.test(name));
const groups=new Map();
for(const name of migrations){const prefix=Number(name.slice(0,3));if(prefix<67)continue;const list=groups.get(prefix)||[];list.push(name);groups.set(prefix,list);}
for(const[prefix,names]of groups)assert(names.length===1,`Migration prefix ${String(prefix).padStart(3,'0')} is reused: ${names.join(', ')}`);

console.log('Security/operator clarity static regression checks passed.');