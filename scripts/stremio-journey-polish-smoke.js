'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const customer=read('src/platform/customer-stremio.js');
const router=read('src/platform/router.js');
const dashboard=read('views/customer/dashboard.ejs');
const checkout=read('public/js/customer-checkout.js');
const access=read('views/customer/jellyfin.ejs');
const accessJs=read('public/js/customer-jellyfin.js');
const components=read('src/access/plan-components.js');
const household=read('src/stremio/household-access.js');
const adminJourney=read('public/js/admin-stremio-journey.js');
const adminCss=read('public/css/admin-stremio-journey.css');
const capabilityCss=read('public/css/admin-capability.css');
const adminShell=read('src/platform/admin-html-core.js');

// Customer language describes the commercial model without exposing IP-family,
// token/credential, lease, or addon implementation terms. Stremio management is
// consolidated on My Access; Account Home is summary/navigation only.
assert(customer.includes('household connection')&&!customer.includes('household IP'),'customer Stremio status must use household-connection language');
assert(customer.includes('new Stremio installation link is ready')&&!customer.includes('installation credential has been rotated'),'customer link rotation must be explained as a normal replacement');
assert(customer.includes("r.get('/account/stremio',(req,res)=>res.redirect(302,'/account/access#stremio-access'))"),'legacy Stremio URL must redirect to the My Access Stremio section');
for(const retired of ['operations-settings','runtime-settings','customer-nav-html','stremio/foundation','async function model(','function stremioDeepLink(','function householdLabel('])assert(!customer.includes(retired),`retired standalone Stremio model code returned: ${retired}`);
assert(customer.includes('async function issueCustomerInstallation('),'Stremio installation issuing must be reusable by both the trial and manual recovery flows');
assert(customer.includes('module.exports={createCustomerStremioRouter,issueCustomerInstallation};'),'customer Stremio module must export the mounted router and shared installation issuer');
assert(customer.includes('installationLinks.current(req,customerId)'),'My Access must recover the authoritative current installation credential');
assert(customer.includes("res.setHeader('Cache-Control','no-store, private, max-age=0')"),'installation state endpoint must remain no-store');

// Home must be a summary/navigation surface. This is server-rendered behavior,
// not a client-side hide, so cached JavaScript cannot bring the setup panel back.
assert(dashboard.includes('class="multiAccessSummary"'),'Home must keep the active access summary');
assert(dashboard.includes('class="accessSummaryCard"'),'Home must keep active plan cards');
assert(dashboard.includes('href="/account/access"'),'Home must link active access to My Access');
assert(!dashboard.includes('id="stremio-access"'),'Home must not server-render the Stremio setup panel');
assert(!dashboard.includes('action="/account/stremio/install"'),'Home must not own Stremio installation actions');
assert(!dashboard.includes('action="/account/stremio/reset-household"'),'Home must not own Stremio household actions');
assert(!dashboard.includes('action="/account/stremio/revoke"'),'Home must not own Stremio revoke actions');
assert(!dashboard.includes('Installation manifest'),'Home must not expose Stremio setup details');
assert(!checkout.includes("querySelector('#stremio-access')"),'Home must not rely on JavaScript to remove server-rendered Stremio setup');

// My Access owns the setup experience and loads the same recovered installation
// state used by the server. The rich setup is rendered there after a no-store read.
assert(access.includes('id="stremio-access"')&&access.includes('data-stremio-access'),'My Access must contain the Stremio setup mount');
for(const copy of ['Household access','Use a different household connection','Installation manifest'])assert(accessJs.includes(copy),`My Access Stremio section missing task-focused copy: ${copy}`);
for(const instructions of ['Open Stremio.','Profile → Addons → Add addon.','Paste this private manifest/install URL and install it.','Keep this link private.'])assert(accessJs.includes(instructions),`My Access Stremio setup instructions missing: ${instructions}`);
for(const route of ['/account/stremio/installation.json','/account/stremio/install','/account/stremio/reset-household','/account/stremio/revoke'])assert(accessJs.includes(route),`My Access Stremio UI missing ${route}`);
assert(accessJs.includes("cache:'no-store'"),'My Access must fetch fresh installation-link state');
assert(accessJs.includes("name=\"returnTo\" value=\"access\""),'My Access Stremio mutations must return to My Access');
for(const jargon of ['Replace household IP','installation credential','addon URL','/64'])assert(!accessJs.includes(jargon),`My Access Stremio section exposes implementation wording: ${jargon}`);
assert(!fs.existsSync(path.join(root,'views/customer/stremio.ejs')),'retired standalone Stremio setup view must stay removed');

// Starting a Stremio or bundle trial is one customer action: the trial route
// immediately issues the private installation link instead of requiring a
// second Create Stremio link click. Failure is isolated so the already-created
// trial remains active and My Access can offer the existing recovery route.
assert(router.includes('autoCreateStremioTrialInstallation'),'trial flow must own automatic Stremio installation-link creation');
assert(router.includes("['stremio', 'bundle'].includes(serviceType)"),'automatic installation must be limited to Stremio-capable trials');
assert(router.includes('return issueCustomerInstallation(customerId, { actorUserId: customerUserId });')&&router.includes('await autoCreateStremioTrialInstallation(req.session.customerId, req.session.customerUserId, subscription)'),'trial flow must issue the link immediately after trial activation through the shared customer installation helper');
assert(router.includes('Your Stremio trial is active, but the installation link could not be created automatically.'),'automatic-link failure must not claim the trial itself failed');

// The install link route must not claim success when managed-account
// provisioning underneath actually failed -- it has to check the outcome
// instead of always redirecting to the success message.
assert(/const\{provisioned\}\s*=\s*await issueCustomerInstallation/.test(customer),'install route must capture the managed-provisioning outcome instead of discarding it');
assert(/homeRedirect\(provisioned\s*\?\s*'message'\s*:\s*'error'/.test(customer),'install route must show an error state when managed provisioning did not complete');
assert(customer.includes('automatic access setup is still finishing'),'a failed managed-provisioning attempt must tell the customer setup is still in progress rather than silently claiming success');

// Shared labels and blocked-playback guidance use the same plain-language model
// while all persisted compatibility field names stay unchanged. Normal household
// exhaustion keeps the replacement guidance; an unresolved reverse-proxy client
// identity is a separate fail-closed state and must explain why playback stopped.
assert(components.includes('household connection${households === 1 ?')&&!components.includes('household IP${households === 1 ?'),'shared Stremio plan labels must use household connections');
assert(household.includes("'Household IP limit reached'")&&household.includes('allowed household internet connections')&&household.includes('change your household connection'),'blocked playback must explain the household limit and replacement action plainly');
assert(household.includes("'Household IP could not be verified'")&&household.includes('Playback is blocked rather than sharing a proxy address between customers.'),'unresolved proxy identity must fail closed with plain-language guidance');
assert(household.includes('stremio_ip_replacement_policy_snapshot')&&household.includes('stremio_ip_replacement_cooldown_minutes_snapshot'),'persisted Stremio replacement contracts must remain unchanged');
assert(household.includes("'X-CAPTAiNFiN-429-Reason', 'household_network'"),'runtime household-network response contract must remain unchanged');

// Admin UX remains a presentation layer over canonical source, plan and customer
// routes. The retired setup journey and source explainer stay absent; operational
// notices and the actual source controls remain owned by the server-rendered page.
assert(!adminJourney.includes('stremioJourney')&&!adminJourney.includes('insertJourney('),'Stremio polish must not inject Sources / Plan delivery / Customer install journey cards');
assert(!adminJourney.includes('Stremio setup journey')&&!adminJourney.includes('stremioJourneyStep'),'retired Stremio setup-card markup must stay removed');
assert(!adminJourney.includes('Choose where Stremio can find your library.')&&!adminJourney.includes('How playback is delivered'),'retired Stremio source explainer must not be recreated by presentation JavaScript');
assert(adminJourney.includes('Manage Stremio sources')&&adminJourney.includes('Save delivery sources'),'plan delivery must use operator-friendly source actions');
assert(adminJourney.includes('Advanced order')&&adminJourney.includes('Advanced maintenance')&&adminJourney.includes('Technical diagnostics'),'technical source ordering, maintenance and diagnostics must use progressive disclosure');
assert(adminJourney.includes('textContent')&&!adminJourney.includes('fetch('),'Stremio polish must change presentation only and must not own server state');

assert(capabilityCss.includes("@import url('/css/admin-stremio-journey.css')"),'admin capability bundle must load Stremio polish styles');
assert(adminShell.includes('/js/admin-stremio-journey.js'),'admin shell must load Stremio polish behavior');
assert(adminCss.includes('.stremioJourney{display:none!important}'),'old cached journey markup must remain defensively hidden');
for(const contract of ['.stremioAdvancedMaintenance','.stremioOrderDetails','@media(max-width:800px)'])assert(adminCss.includes(contract),`Stremio polish CSS missing ${contract}`);
assert(!adminCss.includes('.stremioFlowOverview'),'retired source-explainer styling must stay removed');

console.log('stremio journey polish smoke: ok');
