'use strict';

const assert = require('assert');
const fs = require('fs');
require('./free-access-inactivity-consistency-smoke');

const provision = fs.readFileSync('src/jellyfin/provisioning-engine.js', 'utf8');
const dash = fs.readFileSync('src/platform/customer-dashboard.js', 'utf8');
const view = fs.readFileSync('views/customer/dashboard.ejs', 'utf8');
const nav = fs.readFileSync('views/customer/_nav.ejs', 'utf8');
const pendingRegistration = fs.readFileSync('src/security/pending-registration.js', 'utf8');
const publicAuth = fs.readFileSync('src/platform/customer-public-auth.js', 'utf8');
const storefront = fs.readFileSync('src/platform/storefront.js', 'utf8');
const register = fs.readFileSync('views/customer/register.ejs', 'utf8');

assert(/accessKind\s*=\s*isTrial\s*\?\s*['"]trial['"]/.test(provision), 'placement must classify trial/free/paid');
assert(/\$2::text='free'\s+THEN TRUE/.test(provision), 'free access must not require paid_enabled');
assert(/getCustomerState\(customerId\)/.test(dash), 'customer dashboard must expose provisioning state through the canonical customerId');
assert(/\/account\/provisioning\/retry/.test(dash), 'customer must have provisioning retry route');
assert(/include\('_nav'/.test(view), 'customer dashboard must use the shared left navigation');
for(const label of ['Home','Activity','Support','Help','Payments','Account'])assert(nav.includes(label),`customer left navigation missing ${label}`);
assert(!nav.includes('>Setup</a>')&&!nav.includes('Plan &amp; billing'),'customer left navigation must not restore redundant Setup or Plan & billing tabs');
assert(nav.includes('navBenefits')&&nav.includes('navOverseerrUrl'),'Benefits and Request content must remain conditional customer navigation');
assert(/Your active access/.test(view)&&/Everything you have, in one place/.test(view),'multi-access account summary missing');
assert(/access_lane==='free'/.test(view)&&/Premium Jellyfin/.test(view),'dashboard must distinguish Free and Premium Jellyfin access lanes');
assert(/Free Server, Premium Jellyfin and Stremio can stay active independently/.test(view),'dashboard must explain independent simultaneous access');
assert(/readyAccounts\.forEach/.test(view)&&/a\.public_url/.test(view)&&/a\.jellyfin_username/.test(view),'dashboard must expose each ready Jellyfin server and username');
assert(/without giving up your Free Server access/.test(view),'paid access changes must preserve existing Free Server access');
assert(/provisioningState&&provisioningState\.last_error/.test(view), 'customer provisioning failure reason missing');

assert(/const FREE_HOLD_MINUTES=10;/.test(pendingRegistration),'Free Server reservation must last exactly 10 minutes');
assert(/async function reserveFreeAccess/.test(pendingRegistration)&&/holder_session_hash/.test(pendingRegistration),'Free Server must have a session-bound pre-registration hold');
assert(/FREE_ACCESS_CAPACITY_EXHAUSTED/.test(pendingRegistration)&&/No free places currently available/.test(pendingRegistration),'last-place loser must receive the canonical no-capacity result');
assert(/wantsFree&&String\(req\.body\.reserveFree\|\|''\)==='1'/.test(publicAuth)&&/reserveFreeAccess\(\{sessionId:req\.sessionID\}\)/.test(publicAuth),'Free Server hold must be created only by the explicit registration POST');
assert(/method=\"post\" action=\"\/account\/register\"/.test(storefront)&&/name=\"reserveFree\" value=\"1\"/.test(storefront),'storefront Free Server CTA must be an explicit POST reservation action');
assert(/Reserve \/ Create Free Account/.test(register)&&/freeIntent && !hasFreeReservation/.test(register),'Free registration page must require reservation before showing signup details');
assert(/no-store, private, max-age=0, must-revalidate/.test(storefront)&&/Surrogate-Control','no-store/.test(storefront),'storefront capacity must be no-store at browser and surrogate caches');
assert(!/public, max-age=60/.test(storefront),'storefront must not retain the old one-minute public capacity cache');

console.log('free access customer portal smoke: ok');
