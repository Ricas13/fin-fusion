'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const customer=read('src/platform/customer-stremio.js');
const dashboard=read('views/customer/dashboard.ejs');
const components=read('src/access/plan-components.js');
const household=read('src/stremio/household-access.js');
const adminJourney=read('public/js/admin-stremio-journey.js');
const adminCss=read('public/css/admin-stremio-journey.css');
const capabilityCss=read('public/css/admin-capability.css');
const adminShell=read('src/platform/admin-html-core.js');

// Customer language describes the commercial model without exposing IP-family,
// token/credential, lease, or addon implementation terms. Stremio management is
// consolidated on Account Home; the historical standalone view stays retired.
assert(customer.includes('household connection')&&!customer.includes('household IP'),'customer Stremio status must use household-connection language');
assert(customer.includes('new Stremio installation link is ready')&&!customer.includes('installation credential has been rotated'),'customer link rotation must be explained as a normal replacement');
assert(customer.includes("r.get('/account/stremio',(req,res)=>res.redirect(302,'/account#stremio-access'))"),'legacy Stremio URL must redirect to the Account Home Stremio section');
for(const retired of ['operations-settings','runtime-settings','customer-nav-html','stremio/foundation','async function model(','function stremioDeepLink(','function householdLabel('])assert(!customer.includes(retired),`retired standalone Stremio model code returned: ${retired}`);
assert(customer.includes('module.exports={createCustomerStremioRouter};'),'customer Stremio module must expose only the mounted router after standalone model retirement');
for(const copy of ['Install your private Stremio access','Household access','Use a different household connection','Installation manifest'])assert(dashboard.includes(copy),`Account Home Stremio section missing task-focused copy: ${copy}`);
for(const jargon of ['Replace household IP','installation credential','addon URL','/64'])assert(!dashboard.includes(jargon),`Account Home Stremio section exposes implementation wording: ${jargon}`);
assert(dashboard.includes('action="/account/stremio/install"')&&dashboard.includes('action="/account/stremio/reset-household"')&&dashboard.includes('action="/account/stremio/revoke"'),'Account Home Stremio actions must keep their existing server routes');
assert(!fs.existsSync(path.join(root,'views/customer/stremio.ejs')),'retired standalone Stremio setup view must stay removed');

// The install link route must not claim success when managed-account
// provisioning underneath actually failed -- it has to check the outcome
// instead of always redirecting to the success message.
assert(/const provisioned\s*=\s*await preprovisionManaged/.test(customer),'install route must capture the managed-provisioning outcome instead of discarding it');
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
// routes. The old three-card setup journey is intentionally gone so operational
// pages start with their actual controls instead of duplicate navigation.
assert(!adminJourney.includes('stremioJourney')&&!adminJourney.includes('insertJourney('),'Stremio polish must not inject Sources / Plan delivery / Customer install journey cards');
assert(!adminJourney.includes('Stremio setup journey')&&!adminJourney.includes('stremioJourneyStep'),'retired Stremio setup-card markup must stay removed');
assert(adminJourney.includes('Manage Stremio sources')&&adminJourney.includes('Save delivery sources'),'plan delivery must use operator-friendly source actions');
assert(adminJourney.includes('Advanced order')&&adminJourney.includes('Advanced maintenance')&&adminJourney.includes('Technical diagnostics'),'technical source ordering, maintenance and diagnostics must use progressive disclosure');
assert(adminJourney.includes('textContent')&&!adminJourney.includes('fetch('),'Stremio polish must change presentation only and must not own server state');

assert(capabilityCss.includes("@import url('/css/admin-stremio-journey.css')"),'admin capability bundle must load Stremio polish styles');
assert(adminShell.includes('/js/admin-stremio-journey.js'),'admin shell must load Stremio polish behavior');
for(const contract of ['.stremioFlowOverview','.stremioAdvancedMaintenance','.stremioOrderDetails','@media(max-width:800px)'])assert(adminCss.includes(contract),`Stremio polish CSS missing ${contract}`);

console.log('stremio journey polish smoke: ok');
