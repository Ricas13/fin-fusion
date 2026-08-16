'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.join(__dirname,'..'),text=file=>fs.readFileSync(path.join(root,file),'utf8');
function expect(value,message){assert(value,message)}

const firstRun=text('src/auth/first-run-setup.js'),firstRunController=text('src/auth/first-run-controller.js');
expect(/ADMIN_PASSWORD/.test(firstRun)&&/claim/.test(firstRun),'First-run flow must keep a protected administrator claim path.');
expect(/csrf/.test(firstRunController)&&/rate/i.test(firstRunController),'First-run controller must keep request protections.');
const auth=text('src/auth/service-core.js'),staff=text('src/auth/staff-controller.js');
expect(/session_version/.test(auth)&&/registerSession/.test(auth),'Staff auth must keep revocable server-side sessions.');
expect(/req\.session\.authUserId/.test(staff)&&/csrfToken/.test(staff),'Native staff login must establish the canonical authenticated session and CSRF token.');
const customerAuth=text('src/platform/customer-auth.js');
expect(/password_hash/.test(customerAuth)&&/forgot-password/.test(customerAuth),'Customer portal must keep password authentication and recovery.');
const security=text('src/platform/admin-security.js');
expect(/Two-factor/.test(security)&&/sessions/.test(security),'Admin security must expose second factor and session controls.');

const setup=text('src/platform/admin-setup.js');
expect(/readiness/i.test(setup)&&/payment/i.test(setup),'Setup should remain a readiness workflow rather than a second settings tree.');
const support=text('src/platform/support-policy.js'),help=text('src/platform/public-help.js');
expect(/docsUrl/.test(support)&&/Help & guides/.test(help),'Managed documentation URL must be discoverable from public Help.');

const pending=text('src/security/pending-registration.js'),publicAuth=text('src/platform/public-auth.js');
const jobs=text('src/automation/jobs.js');
expect(/pending_registrations/.test(pending)&&/password_hash/.test(pending)&&/token_hash/.test(pending),'Verified public registrations must be staged with hashed credentials/tokens.');
expect(/pendingRegistrations\.begin/.test(publicAuth)&&/verify-registration/.test(publicAuth)&&/pendingRegistrations\.consume/.test(publicAuth),'Public verification must create the real customer only after consuming a pending registration.');
expect(/pending_registration_cleanup/.test(jobs),'Expired pending registrations must be an automation job.');

const emailChange=text('src/security/customer-email-change.js');
expect(/notifyOldAddress/.test(emailChange)&&/email_change_security_completed/.test(emailChange),'Email changes must notify the old address out of band.');
const servers=text('src/platform/admin-servers.js');
expect(/outbound\.safeFetch\(`\$\{baseUrl\}\/System\/Info`/.test(servers),'Jellyfin credential probes must use the pinned outbound URL policy.');
const serverForm=text('views/admin/server-form.ejs');
expect(/include\('_nav',\{siteName,activeNav:'servers'\}\)/.test(serverForm),'Server form must render the canonical admin navigation.');
const csp=text('scripts/csp-inline-audit.js');
expect(/Scan the complete source/.test(csp)&&!/lines\.forEach/.test(csp),'CSP static audit must remain multiline-aware.');

const navModel=require('../src/platform/admin-nav'),settings=text('src/platform/admin-original-settings.js');
const settingsGroup=navModel.groups.find(group=>group.key==='settings');
expect(Boolean(settingsGroup),'Settings navigation group must exist.');
const settingsLabels=settingsGroup.pages.map(page=>page[1]);
for(const label of ['General','My Profile','Notifications','Branding','Integrations','Security','Operations','Backups & Transfer'])expect(settingsLabels.includes(label),`Settings navigation is missing ${label}.`);
for(const obsolete of ['Commerce','Advanced','My Notifications'])expect(!settingsLabels.includes(obsolete),`Settings navigation must not reintroduce duplicate/obsolete ${obsolete}.`);
expect(/pendingRegistrations\.stats/.test(settings)&&/Registration & verification/.test(settings),'Security settings must expose staged-registration state.');
expect(/requested==='commerce'.*\/admin\/commerce/.test(settings),'Legacy Settings Commerce links must resolve to the canonical Commerce workflow.');
expect(/requested==='advanced'.*\/admin\/configuration/.test(settings),'Legacy Settings Advanced links must resolve to Configuration Transfer.');

const stremio=require('../src/entitlements/stremio-gate');
const oldRuntime=process.env.STREMIO_RUNTIME_ENABLED;delete process.env.STREMIO_RUNTIME_ENABLED;
expect(stremio.assertAcquirable({service_type:'jellyfin'}).service_type==='jellyfin','Jellyfin acquisition must remain available while Stremio runtime is disabled.');
let blocked=false;try{stremio.assertAcquirable({service_type:'stremio'});}catch(error){blocked=/not available/.test(error.message);}expect(blocked,'Stremio acquisition must fail closed before the runtime is enabled.');
process.env.STREMIO_RUNTIME_ENABLED='true';
expect(stremio.runtimeReady()===false,'The enable flag alone must not make Stremio sellable before a real runtime module is present.');
if(oldRuntime===undefined)delete process.env.STREMIO_RUNTIME_ENABLED;else process.env.STREMIO_RUNTIME_ENABLED=oldRuntime;
const lifecycle=text('src/payments/lifecycle.js');
expect(/stremio\.assertAcquirable/.test(lifecycle),'Canonical paid/free/trial lifecycle must enforce the Stremio runtime gate.');

// Policy Drift remains load-bearing but its former tuning form is deliberately
// gone from the operator page; cadence values are now informational defaults.
const driftAdmin=text('src/platform/admin-drift.js');
expect(/Audit cadence/.test(driftAdmin)&&!/drift\/settings/.test(driftAdmin),'Policy Drift low-level tuning must stay out of the normal operator form.');

// Historical migrations intentionally include duplicate numeric prefixes and
// are keyed by complete filename. Freeze that history, but reject any new
// duplicate prefix after the current migration set.
const migrationFiles=fs.readdirSync(path.join(root,'db','migrations')).filter(file=>file.endsWith('.sql')).sort();
const prefixMap=new Map();for(const file of migrationFiles){const prefix=file.split('_')[0];if(!prefixMap.has(prefix))prefixMap.set(prefix,[]);prefixMap.get(prefix).push(file);}
for(const [prefix,files] of prefixMap){if(files.length<=1)continue;expect(Number(prefix)<=76,`New duplicate migration prefix ${prefix}: ${files.join(', ')}`);}

console.log('Security/operator clarity static regression checks passed.');
