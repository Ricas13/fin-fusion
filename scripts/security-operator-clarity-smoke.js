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

const abuseProtection=text('src/security/public-abuse-protection.js');
const application=text('src/application.js');
const customerLoginView=text('views/customer/login.ejs');
const staffLoginView=text('views/auth/staff-login.ejs');
const registrationView=text('views/customer/register.ejs');
const passwordResetView=text('views/customer/forgot-password.ejs');
const abuseAdmin=text('src/platform/admin-abuse-protection.js');
for(const route of ["'/login'","'/account/login'","'/account/register'"]){
    assert(abuseProtection.includes(route),'Turnstile core authentication coverage is missing '+route+'.');
}
assert(/CORE_AUTH_PATHS\.has\(path\)/.test(abuseProtection),'Core sign-in/sign-up Turnstile gates must be mandatory whenever Turnstile is enabled.');
assert(/body\.action !== expectedAction/.test(abuseProtection),'Turnstile tokens must be bound to the intended authentication action.');
assert(application.includes("app.get('/login', publicAbuseProtection.middleware")&&application.includes("app.post('/login', publicAbuseProtection.middleware"),'Staff sign-in must pass through Turnstile before the staff controller.');
for(const [label,view,action] of [
    ['customer login',customerLoginView,'customer_login'],
    ['staff login',staffLoginView,'staff_login'],
    ['registration',registrationView,'customer_registration'],
    ['password reset',passwordResetView,'customer_password_reset']
]){
    assert(view.includes('cf-turnstile')&&view.includes('data-action="<%= turnstileAction %>"'),`${label} must render the server-selected Turnstile action.`);
    assert(abuseProtection.includes(`'${action}'`),`${label} Turnstile action must have a server-side expected action.`);
}
assert(/Always protected while enabled/.test(abuseAdmin)&&!/name:'protectRegistration'/.test(abuseAdmin),'Admin settings must make sign-in/sign-up Turnstile coverage non-optional.');

const pending=text('src/security/pending-registration.js');
const publicAuth=text('src/platform/customer-public-auth.js');
const customerCore=text('src/customers.js');
const jobs=text('src/automation/jobs.js');
assert(/pending_registrations/.test(pending)&&/password_hash/.test(pending)&&/token_hash/.test(pending),'Verified public registrations must be staged with hashed credentials/tokens.');
assert(/pendingRegistrations\.begin/.test(publicAuth)&&/verify-registration/.test(publicAuth)&&/pendingRegistrations\.consume/.test(publicAuth),'Public verification must create the real customer only after consuming a pending registration.');
assert(/assertNoUnclaimedJellyfinUsername/.test(customerCore)&&/jellyfin_accounts ja JOIN customers c/.test(customerCore)&&/c\.user_id IS NULL/.test(customerCore),'Immediate public registration must not take an unclaimed imported Jellyfin username.');
assert((pending.match(/assertNoUnclaimedJellyfinUsername/g)||[]).length>=3&&/Use the existing-account claim link/.test(pending),'Verified public registration must block unclaimed imported Jellyfin usernames before and after email verification.');
assert(/pending_registration_cleanup/.test(jobs),'Expired pending registrations must be an automation job.');

const emailChange=text('src/security/customer-email-change.js');
assert(/notifyOldAddress/.test(emailChange)&&/email_change_security_completed/.test(emailChange),'Email changes must notify the old address out of band.');
const servers=text('src/platform/admin-servers.js');
assert(/outbound\.safeFetch\(new URL\(path, `\$\{baseUrl\}\/`\)/.test(servers)&&/credentialProbeEndpoint\(provider\)/.test(servers),'Media-server credential probes must use the pinned outbound URL policy and an authenticated provider endpoint.');
const serverForm=text('views/admin/server-form.ejs');
assert(/include\('_nav',\{siteName,activeNav:'servers'\}\)/.test(serverForm),'Server form must render the canonical admin navigation.');
const csp=text('scripts/csp-inline-audit.js');
assert(/Scan the complete source/.test(csp)&&!/lines\.forEach/.test(csp),'CSP static audit must remain multiline-aware.');

const support=text('src/platform/support-policy.js'),help=text('src/platform/public-help.js'),publicPages=text('src/platform/public-pages.js');
assert(/docsUrl/.test(support)&&/docsUrl/.test(publicPages)&&/link\('Contact','\/contact'\)/.test(help),'Managed documentation URL must remain discoverable from public pages: pre-signup Help links to Contact, which publishes the configured docs URL.');
const navModel=require('../src/platform/admin-nav'),settings=text('src/platform/admin-original-settings.js'),fleet=text('src/platform/admin-fleet-operations.js'),serverControl=text('src/platform/admin-server-fleet-dashboard.js'),adminShell=text('src/platform/admin-html-core-base.js'),operatorExperience=text('public/js/operator-experience.js');
const settingsGroup=navModel.groups.find(group=>group.key==='settings');
assert(Boolean(settingsGroup),'Settings navigation group must exist.');
const labels=settingsGroup.pages.map(page=>page[1]);
for(const label of ['General','Security','Connections','Commerce','System'])assert(labels.includes(label),`Settings navigation is missing condensed control room ${label}.`);
for(const contextual of ['branding','support-policy','notification-settings','notification-gateway','request-service'])assert(navModel.hiddenPages[contextual],`Settings contextual workflow is missing ${contextual}.`);
assert(navModel.hiddenPages.branding.parentKey==='settings-general'&&navModel.hiddenPages['support-policy'].parentKey==='settings-general','Branding and Support & legal must remain contextual to General.');
assert(navModel.hiddenPages['notification-settings'].parentKey==='settings-integrations'&&navModel.hiddenPages['notification-gateway'].parentKey==='settings-integrations'&&navModel.hiddenPages['request-service'].parentKey==='settings-integrations','Notifications, delivery health and request service must remain contextual to Connections.');
assert(!labels.includes('Backups'),'Backups must live under Operations rather than global Settings.');
for(const personal of ['My Profile','My Notifications','My Security'])assert(!labels.includes(personal),`Personal ${personal} must live under My account rather than global Settings navigation.`);
for(const obsolete of ['Advanced','Operations','Stremio','Notifications','Branding','Integrations','Support & legal'])assert(!labels.includes(obsolete),`Settings navigation must not reintroduce specialist/obsolete ${obsolete} as a top-level destination.`);
assert(/headerActionLabel\">My account/.test(adminShell),'Admin shell must expose a dedicated My account area.');
assert(/href=\"\/admin\/profile\">My profile/.test(adminShell)&&/href=\"\/admin\/profile\/notifications\">My notifications/.test(adminShell)&&/href=\"\/admin\/security\">My security/.test(adminShell),'My account area must expose personal profile, notifications and security.');
assert(navModel.hiddenPages['admin-2fa-policy']?.page?.[2]==='/admin/settings/admin-2fa','Platform-wide administrator 2FA policy must remain owned by Settings → Security.');
assert(operatorExperience.includes("['Turnstile & abuse protection','/admin/settings/abuse-protection'")&&operatorExperience.includes("['Administrator 2FA','/admin/settings/admin-2fa'"),'Security control room must expose Turnstile and administrator 2FA contextually.');
const operationsGroup=navModel.groups.find(group=>group.key==='automation');
assert(Boolean(operationsGroup),'Operations navigation group must exist.');
assert(operationsGroup.pages.some(page=>page[0]==='backups'&&page[1]==='Backups & Recovery'&&page[2]==='/admin/backups'),'Backup controls must be discoverable as Operations → Backups & Recovery.');
const jellyfinGroup=navModel.groups.find(group=>group.key==='jellyfin');
assert(Boolean(jellyfinGroup),'Jellyfin navigation group must exist.');
assert(navModel.hiddenPages['fleet-operations']?.parentKey==='servers'&&navModel.hiddenPages.libraries?.parentKey==='servers','Placement and Libraries must be nested beneath Jellyfin Servers rather than becoming separate primary sections.');
assert(navModel.aliases.operations==='servers'&&!navModel.aliases['fleet-operations']&&!navModel.aliases.libraries,'Legacy Operations may resolve to Servers, while durable Placement and Libraries pages must retain their own nested active identity.');
assert(jellyfinGroup.pages.some(page=>page[1]==='Servers'&&page[2]==='/admin/servers'),'Managed Jellyfin servers must be discoverable under Jellyfin.');
assert(/\/admin\/servers\/operations\/server\/\$\{esc\(server\.id\)\}\/placement-mode/.test(serverControl)&&/\/admin\/libraries\/\$\{esc\(server\.id\)\}\/refresh/.test(serverControl),'Servers must expose placement and library scan controls inline.');
const stremioGroup=navModel.groups.find(group=>group.key==='stremio');
assert(Boolean(stremioGroup),'Stremio navigation group must exist.');
assert(stremioGroup.pages.some(page=>page[0]==='stremio-sources'&&page[1]==='Stremio'&&page[2]==='/admin/servers/stremio'),'External Jellyfin sources must remain discoverable through the single Stremio control room.');
assert(navModel.hiddenPages['stremio-playback']?.parentKey==='stremio-sources','Stremio IP access must remain contextual to the Stremio control room.');
assert(/Public URL & regional format/.test(settings)&&/Public base URL/.test(settings)&&/Timezone/.test(settings),'General settings must own canonical public URL and regional formatting.');
assert(/Session & registration limits/.test(settings)&&/Trusted outbound hostnames/.test(settings)&&/Abandoned activation cleanup/.test(settings),'Security settings must own session, outbound-trust and pending-activation safety controls.');
assert(/Placement health policy/.test(serverControl)&&/Future capacity preview/.test(serverControl)&&/placement-mode/.test(fleet),'Servers must own placement-health, drain/maintenance and simulation controls while legacy fleet mutations remain compatible.');
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
assert(/Automatic check cadence/.test(driftAdmin)&&!/drift\/settings/.test(driftAdmin),'Access consistency low-level tuning must stay out of the normal operator form.');

const migrations=fs.readdirSync(path.join(root,'db','migrations')).filter(name=>/^\d{3}_.*\.sql$/.test(name));
const groups=new Map();
for(const name of migrations){const prefix=Number(name.slice(0,3));if(prefix<67)continue;const list=groups.get(prefix)||[];list.push(name);groups.set(prefix,list);}
for(const[prefix,names]of groups)assert(names.length===1,`Migration prefix ${String(prefix).padStart(3,'0')} is reused: ${names.join(', ')}`);

console.log('Security/operator clarity static regression checks passed.');
