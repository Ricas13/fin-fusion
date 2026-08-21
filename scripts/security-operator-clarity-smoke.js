'use strict';

const fs=require('fs');
const path=require('path');
const stepUp=require('../src/auth/admin-step-up');
const application=require('../src/application');
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
    '/admin/servers/11111111-1111-1111-1111-111111111111',
    '/admin/settings/registration',
    '/admin/settings/abuse-protection',
    '/admin/settings/stremio/servers/11111111-1111-1111-1111-111111111111',
    '/admin/operations',
    '/admin/security/2fa-policy'
])assert(post(route),`High-impact admin route is missing step-up coverage: ${route}`);
assert(!post('/admin/server-migrations/legacy/apply'),'Stale server-migrations URL unexpectedly remains security-significant.');
assert(!post('/admin/security/step-up'),'Step-up verification must not recursively require step-up.');

const paypal=text('src/payments/paypal.js');
assert(/immutableSubscriptionContract/.test(paypal),'PayPal activation must resolve an immutable subscription contract.');
assert(/activation was refused without an immutable local contract/.test(paypal),'PayPal subscription activation must fail closed without a local contract.');
assert(/reverseReferralForDirectIdentity/.test(paypal),'PayPal reversals must revisit already-rewarded referrals.');
const stripe=text('src/payments/stripe.js');
assert(/reverseReferralForDirectIdentity/.test(stripe),'Stripe reversals must revisit already-rewarded referrals.');
const referrals=text('src/referrals.js'),affiliateCredits=text('src/affiliate-credits.js');
assert(/revisitRewardAfterAdversePayment/.test(referrals)&&/affiliateCredits\.reverseReward/.test(referrals),'Adverse payments must revisit already-earned affiliate service credit.');
assert(/'reversed'/.test(affiliateCredits)&&/already-delivered service was preserved/i.test(referrals),'Affiliate reward reversal must remove unspent credit without clawing back delivered service.');

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
const navModel=require('../src/platform/admin-nav'),settings=text('src/platform/admin-original-settings.js'),fleet=text('src/platform/admin-fleet-operations.js'),adminShell=text('src/platform/admin-html-core-base.js');
const stremioRuntime=text('src/stremio/runtime.js'),applicationSource=text('src/application.js');
const settingsGroup=navModel.groups.find(group=>group.key==='settings');
assert(Boolean(settingsGroup),'Settings navigation group must exist.');
const labels=settingsGroup.pages.map(page=>page[1]);
for(const label of ['General','Notifications','Branding','Integrations','Security','Support & legal'])assert(labels.includes(label),`Settings navigation is missing ${label}.`);
assert(!labels.includes('Backups'),'Backups must live under Operations rather than global Settings.');
for(const personal of ['My Profile','My Notifications','My Security'])assert(!labels.includes(personal),`Personal ${personal} must live under My account rather than global Settings navigation.`);
for(const obsolete of ['Commerce','Advanced','Operations','Stremio'])assert(!labels.includes(obsolete),`Settings navigation must not reintroduce duplicate/obsolete ${obsolete}.`);
assert(/headerActionLabel\">My account/.test(adminShell),'Admin shell must expose a dedicated My account area.');
assert(/href=\"\/admin\/profile\">My profile/.test(adminShell)&&/href=\"\/admin\/profile\/notifications\">My notifications/.test(adminShell)&&/href=\"\/admin\/security\">My security/.test(adminShell),'My account area must expose personal profile, notifications and security.');
assert(navModel.hiddenPages['admin-2fa-policy']?.page?.[2]==='/admin/settings/admin-2fa','Platform-wide administrator 2FA policy must remain owned by Settings → Security.');
const operationsGroup=navModel.groups.find(group=>group.key==='automation');
assert(Boolean(operationsGroup),'Operations navigation group must exist.');
assert(operationsGroup.pages.some(page=>page[1]==='Backups'&&page[2]==='/admin/backups'),'Backup controls must be discoverable as Operations → Backups.');
assert(navModel.hiddenPages['fleet-operations']?.groupKey==='jellyfin'&&navModel.hiddenPages['fleet-operations']?.parentKey==='fleet-operations'&&navModel.hiddenPages['fleet-operations']?.page?.[2]==='/admin/servers/operations','Fleet drain/placement controls must remain owned by the Jellyfin server workflow.');
assert(/current\.group\.pages/.test(adminShell),'Admin shell must render the active hidden workflow page in its owning sidebar group.');
const jellyfinGroup=navModel.groups.find(group=>group.key==='jellyfin');
assert(Boolean(jellyfinGroup),'Jellyfin navigation group must exist.');
assert(jellyfinGroup.pages.some(page=>page[1]==='Servers'&&page[2]==='/admin/servers'),'Managed Jellyfin servers must be discoverable under Jellyfin.');
const stremioGroup=navModel.groups.find(group=>group.key==='stremio');
assert(Boolean(stremioGroup),'Stremio navigation group must exist.');
assert(stremioGroup.pages.some(page=>page[1]==='Sources'&&page[2]==='/admin/servers/stremio'),'External Jellyfin sources must be discoverable as Stremio → Sources.');
assert(/Public URL & regional format/.test(settings)&&/Public base URL/.test(settings)&&/Timezone/.test(settings),'General settings must own canonical public URL and regional formatting.');
assert(/Session & registration limits/.test(settings)&&/Trusted outbound hostnames/.test(settings)&&/Abandoned activation cleanup/.test(settings),'Security settings must own session, outbound-trust and pending-activation safety controls.');
assert(/Placement health policy/.test(fleet)&&/Placement dry run/.test(fleet)&&/placement-mode/.test(fleet),'Fleet operations must own placement-health, drain/maintenance and simulation controls.');
assert(application.proxyTrustSetting('')===false&&application.proxyTrustSetting('1')===1,'Forwarded proxy headers must be ignored unless TRUST_PROXY explicitly scopes trusted hops.');
let trustAllRejected=false;try{application.proxyTrustSetting('true');}catch(error){trustAllRejected=/TRUST_PROXY/.test(error.message)}
assert(trustAllRejected,'TRUST_PROXY must reject trust-all forwarded-header settings.');
let proxyHostnameRejected=false;try{application.proxyTrustSetting('proxy.example.com');}catch(error){proxyHostnameRejected=/TRUST_PROXY/.test(error.message)}
assert(proxyHostnameRejected&&application.proxyTrustSetting('10.0.0.0/8,loopback')==='10.0.0.0/8,loopback','TRUST_PROXY must accept only scoped IP/CIDR entries or known local proxy names.');
assert(/adminMutationRateLimit/.test(applicationSource)&&/admin-mutation/.test(applicationSource),'Authenticated admin POST routes must pass through a persistent mutation rate limiter.');
const publicOriginBlock=stremioRuntime.match(/async function publicOrigin[\s\S]*?\n}/)?.[0]||'';
assert(/operations\.absoluteUrl\(req, '\/'\)/.test(publicOriginBlock)&&!/x-forwarded-host|x-forwarded-proto/.test(publicOriginBlock),'Stremio public origin must use the canonical public URL helper, not forwarded host headers.');
assert(/pendingRegistrations\.stats/.test(settings)&&/Registration & verification/.test(settings),'Security settings must expose staged-registration state.');

const oldRuntime=process.env.STREMIO_RUNTIME_ENABLED;delete process.env.STREMIO_RUNTIME_ENABLED;
assert(stremio.assertAcquirable({service_type:'jellyfin'}).service_type==='jellyfin','Jellyfin acquisition must remain available while Stremio runtime is disabled.');
let blocked=false;try{stremio.assertAcquirable({service_type:'stremio'});}catch(error){blocked=/not available/.test(error.message);}assert(blocked,'Stremio acquisition must fail closed before the runtime is enabled.');
process.env.STREMIO_RUNTIME_ENABLED='true';
assert(stremio.runtimeReady()===true,'Legacy enablement must remain compatible while a real Stremio runtime module is present.');
const stremioRuntimeSettings=text('src/stremio/runtime-settings.js'),productReadiness=text('src/platform/product-readiness.js'),sourcePool=text('src/stremio/source-pool.js');
assert(/eligibleSources<1/.test(stremioRuntimeSettings)&&/readyIndexes<1/.test(stremioRuntimeSettings),'Browser runtime enablement must require a usable indexed Stremio source.');
assert(/plan_sources_unavailable/.test(productReadiness)&&/planSourceState/.test(productReadiness),'New Stremio sales must fail closed when explicitly selected plan sources are unavailable.');
assert(/if\(explicit\)return mapped\.rows/.test(sourcePool),'Explicit Stremio source mappings must never fall open to unrelated sources.');
if(oldRuntime===undefined)delete process.env.STREMIO_RUNTIME_ENABLED;else process.env.STREMIO_RUNTIME_ENABLED=oldRuntime;
const lifecycle=text('src/payments/lifecycle.js');
assert(/stremio\.assertAcquirable/.test(lifecycle),'Canonical paid/free/trial lifecycle must enforce the Stremio runtime gate.');

const driftAdmin=text('src/platform/admin-drift.js');
assert(/Audit cadence/.test(driftAdmin)&&!/drift\/settings/.test(driftAdmin),'Policy Drift low-level tuning must stay out of the normal operator form.');

const migrations=fs.readdirSync(path.join(root,'db','migrations')).filter(name=>/^\d{3}.*\.sql$/.test(name));
const groups=new Map();
for(const name of migrations){const prefix=Number(name.slice(0,3));if(prefix<67)continue;const list=groups.get(prefix)||[];list.push(name);groups.set(prefix,list);}
for(const[prefix,names]of groups)assert(names.length===1,`Migration prefix ${String(prefix).padStart(3,'0')} is reused: ${names.join(', ')}`);

console.log('Security/operator clarity static regression checks passed.');
