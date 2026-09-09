'use strict';

const assert = require('assert');
const fs = require('fs');
require('./free-access-inactivity-consistency-smoke');
require('./customer-my-access-inactivity-smoke');
require('./free-claim-provisioning-repair-smoke');
require('./free-places-discord-notification-smoke');

const provision = fs.readFileSync('src/jellyfin/provisioning-helpers.js', 'utf8');
const dash = fs.readFileSync('src/platform/customer-dashboard.js', 'utf8');
const view = fs.readFileSync('views/customer/dashboard.ejs', 'utf8');
const nav = fs.readFileSync('views/customer/_nav.ejs', 'utf8');
const pendingRegistration = fs.readFileSync('src/security/pending-registration.js', 'utf8');
const publicAuth = fs.readFileSync('src/platform/customer-public-auth.js', 'utf8');
const storefront = fs.readFileSync('src/platform/storefront.js', 'utf8');
const register = fs.readFileSync('views/customer/register.ejs', 'utf8');
const freePlaces = fs.readFileSync('src/automation/free-places-digest.js', 'utf8');
const serverMigration = fs.readFileSync('src/jellyfin/server-migration.js', 'utf8');
const adminServerMigration = fs.readFileSync('src/platform/admin-server-migrations.js', 'utf8');

assert(/const accessKind = String\(plan\?\.billing_interval \|\| plan\?\.contract_billing_interval \|\| ''\) === 'trial'[\s\S]*\? 'free'[\s\S]*: 'paid'/.test(provision), 'placement must classify trial/free/paid');
assert(/accessKind === 'paid'[\s\S]*Boolean\(server\.paid_enabled\)[\s\S]*: true/.test(provision), 'free access must not require paid_enabled');
assert(/getCustomerState\(customerId\)/.test(dash), 'customer dashboard must expose provisioning state through the canonical customerId');
assert(/\/account\/provisioning\/retry/.test(dash), 'customer must have provisioning retry route');
assert(/include\('_nav'/.test(view), 'customer dashboard must use the shared left navigation');
for(const label of ['Home','Activity','Support','Help','Payments','Account'])assert(nav.includes(label),`customer left navigation missing ${label}`);
assert(!nav.includes('>Setup</a>')&&!nav.includes('Plan &amp; billing'),'customer left navigation must not restore redundant Setup or Plan & billing tabs');
assert(nav.includes('navBenefits')&&nav.includes('navOverseerrUrl'),'Benefits and Request content must remain conditional customer navigation');
assert(/Your active access/.test(view)&&/Everything you have, in one place/.test(view),'multi-access account summary missing');
assert(/access_lane==='free'/.test(view)&&/Premium Jellyfin/.test(view),'dashboard must distinguish Free and Premium Jellyfin access lanes');
assert(/Free Server, Premium Jellyfin, Stremio and Emby Shares can stay active independently/.test(view),'dashboard must explain independent simultaneous access across Free Server, Premium Jellyfin, Stremio and Emby');
assert(/readyAccounts\.forEach/.test(view)&&/a\.public_url/.test(view)&&/a\.jellyfin_username/.test(view),'dashboard must expose each ready Jellyfin server and username');
assert(/without giving up your Free Server access/.test(view),'paid access changes must preserve existing Free Server access');
assert(/provisioningState&&provisioningState\.last_error/.test(view), 'customer provisioning failure reason missing');

assert(/const FREE_INTENT_MINUTES=10;/.test(pendingRegistration),'anonymous Free Server signup intent must stay bounded to 10 minutes');
assert(/free_access_registration_intents/.test(pendingRegistration)&&/holder_session_hash/.test(pendingRegistration),'Free Server signup start must create a session-bound intent rather than a capacity hold');
assert(/planCapacity\.lockAndAssert\(client,freePlan\.id/.test(pendingRegistration)&&/INSERT INTO free_access_registration_reservations/.test(pendingRegistration),'validated Free Server registration must reserve capacity only under the canonical capacity lock');
assert(/DELETE FROM free_access_registration_intents WHERE id=\$1/.test(pendingRegistration),'validated Free Server registration must consume the anonymous signup intent after a real reservation is created');
assert(/expires_at=GREATEST\(expires_at,NOW\(\)\+\(\$3::int\*INTERVAL '1 minute'\)\)/.test(pendingRegistration),'verified Free Server registration must retain a bounded post-verification retry window');
assert(/FREE_ACCESS_CAPACITY_EXHAUSTED/.test(pendingRegistration)&&/No free places currently available/.test(pendingRegistration),'last-place loser must receive the canonical no-capacity result');
assert(/wantsFree&&String\(req\.body\.reserveFree\|\|''\)==='1'/.test(publicAuth)&&/reserveFreeAccess\(\{sessionId:req\.sessionID\}\)/.test(publicAuth),'Free Server signup intent must be created only by the explicit registration POST');
assert(/method=\"post\" action=\"\/account\/register\"/.test(storefront)&&/name=\"reserveFree\" value=\"1\"/.test(storefront),'storefront Free Server CTA must explicitly start the Free signup intent');
assert(/Start Free Access signup/.test(register)&&/hasFreeSignupIntent/.test(register)&&/It does not consume or reserve a Free place yet/.test(register),'Free registration page must distinguish the signup window from a real capacity reservation');
assert(/Capacity is checked atomically at submission/.test(register)&&/Create account & reserve available place/.test(register),'Free registration page must explain that scarce capacity is reserved only after valid account submission');
assert(/cf-turnstile/.test(register)&&/reserveFree/.test(register),'signup-intent registration must carry the same Turnstile protection as account creation');
assert(/publicAbuseProtection\.actionForPath\('\/account\/register'\)/.test(storefront)&&/cf-turnstile/.test(storefront),'storefront signup-intent POST must remain Turnstile fail-closed when CAPTCHA is enabled');
assert(/no-store, private, max-age=0, must-revalidate/.test(storefront)&&/Surrogate-Control','no-store/.test(storefront),'storefront capacity must be no-store at browser and surrogate caches');
assert(!/public, max-age=60/.test(storefront),'storefront must not retain the old one-minute public capacity cache');

assert(/STATE_KEY='discord_free_places_status_v1'/.test(freePlaces),'Discord Free Server availability must persist the canonical message identity');
assert(/persistentMessage\(remaining,publicBaseUrl\)/.test(freePlaces)&&/discordMessage\.card/.test(freePlaces)&&/Start Free Access signup/.test(freePlaces),'Discord Free Server availability must render a structured status card with an accurate signup action');
assert(/method:'PATCH'/.test(freePlaces)&&/stored\.messageId&&stored\.text===signature/.test(freePlaces),'Discord availability must edit one message in place and skip unchanged structured capacity');
assert(/availabilityRestored=becameAvailable\(stored\.remaining,remaining\)/.test(freePlaces),'Discord availability must explicitly recognize a durable zero-to-positive reopening');
const routinePatchGuard=/stored\.messageId&&!availabilityRestored/.test(freePlaces)||/else if\(stored\.messageId\)/.test(freePlaces);
assert(routinePatchGuard,'routine capacity changes must PATCH the canonical message while reopening bypasses the edit path');
if(/deleteDiscordMessage/.test(freePlaces)){
  assert(/stored\.messageId&&availabilityRestored/.test(freePlaces)&&/await remove\(\{channelId,messageId:stored\.messageId\}\)/.test(freePlaces),'reopened Free availability must retire the stale full message before posting the fresh notification');
}
assert(/No free places currently available/.test(freePlaces)&&/FREE_INTENT_MINUTES/.test(freePlaces),'persistent Discord status must describe the bounded signup intent without claiming that anonymous visitors consume capacity');
assert(/Starting signup opens a \$\{FREE_INTENT_MINUTES\}-minute window/.test(freePlaces)&&/It does not reserve a place/.test(freePlaces)&&/Capacity is checked atomically/.test(freePlaces),'Discord availability copy must explain the intent-to-reservation boundary accurately');
assert(/require\(['"]\.\.\/security\/pending-registration['"]\)/.test(freePlaces),'Discord digest copy must read the live signup-intent duration constant instead of hardcoding it separately');
assert(/discordMissing\(error\)/.test(freePlaces)&&/send\(\{channelId,text,message,allowEveryone:false\}\)/.test(freePlaces),'deleted Discord status messages must be recreated without @everyone spam');
assert(/refreshFreePlacesStatus\('reservation_created'\)/.test(pendingRegistration),'a successful validated Free Server reservation must nudge the persistent Discord status immediately after commit');
assert(/free_places_digest:30/.test(fs.readFileSync('scripts/automation-worker.js','utf8')),'persistent Discord capacity must also reconcile at least every 30 seconds');

assert(/allowOverCapacity = false/.test(serverMigration)&&/targetAtCapacity && !allowOverCapacity/.test(serverMigration),'normal customer moves must still fail closed at target capacity');
assert(/overCapacityOverride: targetAtCapacity && Boolean\(allowOverCapacity\)/.test(serverMigration),'server migration preflight must explicitly report an armed over-capacity override');
assert(/Allow this move to exceed target server capacity/.test(adminServerMigration),'only the guarded admin migration UI should expose the capacity override');
assert(/allowOverCapacity: check\.allowOverCapacity/.test(adminServerMigration)&&/confirmation[^\n]*MOVE/.test(adminServerMigration),'admin override must survive preview and still require typed MOVE confirmation');

console.log('free access customer portal smoke: ok');