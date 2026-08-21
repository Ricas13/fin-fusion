'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
function read(file){return fs.readFileSync(path.join(root,file),'utf8');}

const runtime=read('src/stremio/runtime.js');
const externalRuntime=read('src/stremio/external-direct-runtime.js');
const householdAccess=read('src/stremio/household-access.js');
const networkIdentity=read('src/access/network-identity.js');
const networkLeases=read('src/access/network-leases.js');
const entitlements=read('src/stremio/entitlements.js');
const managedRuntime=read('src/stremio/managed-runtime.js');
const lifecycle=read('src/stremio/managed-playback-lifecycle.js');
const managedEntitlements=read('src/stremio/managed-entitlements.js');
const sourcePool=read('src/stremio/source-pool.js');
const jellyfinActivity=read('src/jellyfin/activity.js');
const planCreate=read('src/platform/admin-plan-create-v2.js');
const plansList=read('src/platform/admin-plans-list.js');
const storefront=read('src/platform/storefront-core.js');
const customerStremio=read('src/platform/customer-stremio.js');
const adminCustomer=read('src/platform/admin-customer-360.js');
const stremioSetup=read('views/customer/stremio.ejs');
const stremioDashboard=read('views/customer/stremio-dashboard.ejs');
const migration=read('db/migrations/022_retire_stremio_stream_admission.sql');
const familyMigration=read('db/migrations/024_network_lease_families.sql');
const jobs=read('src/automation/jobs.js');

assert(!runtime.includes("require('./source-admission')"),'runtime must not depend on retired commercial source admission');
assert(!runtime.includes('managed-session-reconciler'),'runtime must not start the retired Stremio session-limit reconciler');
assert(!runtime.includes("reason:'stream_limit'")&&!runtime.includes("reason: 'stream_limit'"),'runtime must not emit commercial Stremio stream-limit 429s');
assert(!runtime.includes('X-CAPTAiNFiN-Stream-Active')&&!runtime.includes('X-CAPTAiNFiN-Stream-Limit'),'runtime must not expose retired Stremio stream-count headers');
assert((runtime.match(/reason: 'protocol_rate_limit'/g)||[]).length>=3,'install-token protocol rate limits must remain enabled');
assert(runtime.includes('managedPlayback.startManager({ intervalMs: 5000 })'),'managed playback cleanup manager must remain active');
assert(runtime.includes("householdAccess.claim(entitlement, req"),'playback-start routes must claim the Stremio household network');
assert(runtime.includes('householdAccess.preview(entitlement, req')&&runtime.includes('householdAccess.deniedStream(household,'),'stream result discovery must return a visible household-limit result before source resolution when the IP family is already full');
assert(runtime.includes('cachedStreams(entitlement.id, type, videoId, origin)')&&runtime.includes('rememberStreams(entitlement.id, type, videoId, origin, streams)'),'allowed Stremio searches must use a short-lived result cache after household preview');
assert(runtime.includes("'/stremio/:token/external-play/:sourceId/:itemId/:mediaSourceId'"),'external results must have a household-aware playback-start control route');
assert(runtime.includes('return res.redirect(307, target.url)'),'managed playback must end in a Jellyfin redirect');
assert(runtime.includes('return res.redirect(307, target)'),'external playback must end in a direct external Jellyfin redirect');
assert(runtime.includes('CAPTAiNFiN never receives media bytes'),'runtime contract must explicitly remain control-plane only');
assert(householdAccess.includes("scope: 'stremio'")&&householdAccess.includes('return entitlement?.subscription_id || entitlement?.id'),'Stremio household lease must belong to the subscription, not an individual playback');
assert(householdAccess.includes("'household_network'"),'Stremio network denials must be distinguishable from protocol rate limiting');
assert(householdAccess.includes('Maximum household connections reached')&&householdAccess.includes('deniedStream')&&householdAccess.includes('externalUrl')&&householdAccess.includes('releaseSubject'),'Stremio household denials must produce a visible account-link result and support explicit lease resets');
assert(networkIdentity.includes('networkDescriptor')&&networkIdentity.includes("family: canonical.startsWith('ipv4:') ? 'ipv4' : 'ipv6'"),'network identity must expose the normalized IP family without storing raw addresses');
assert(networkLeases.includes('network_family')&&networkLeases.includes('activeSameFamily')&&networkLeases.includes('function preview'),'household leases must enforce limits per IPv4/IPv6 family and expose a read-only preview');
assert(familyMigration.includes('network_family')&&familyMigration.includes('access_network_leases_subject_family_idx'),'network family migration must add the persistence and lookup shape required by dual-stack household limits');
assert(networkLeases.includes("decision === 'denied'")&&networkLeases.includes("INTERVAL '5 minutes'"),'repeated denied polling must be audit-throttled');

assert(externalRuntime.includes('/external-play/'),'external stream cards must point at the CAPTAiNFiN control-plane start hop');
assert(externalRuntime.includes('playbackTargetFor'),'external control hop must re-authorize the selected plan source before redirecting');
assert(externalRuntime.includes('api_key')&&externalRuntime.includes('directPlaybackUrl'),'external media delivery must still terminate in a direct Jellyfin URL');
assert(!externalRuntime.includes('pipe(res)')&&!runtime.includes('pipe(res)'),'no Stremio video bytes may be relayed by CAPTAiNFiN');

assert(entitlements.includes('function streamLimit(_row){return 1;}'),'persisted Stremio stream_limit must remain a compatibility sentinel');
assert(migration.includes('UPDATE stremio_entitlements')&&migration.includes('SET stream_limit=1'),'existing Stremio entitlements must stay normalized to the sentinel');
assert(!managedRuntime.includes("require('./source-admission')"),'managed stream discovery must not depend on commercial stream admission');
assert(managedRuntime.includes('managedPlayback.issuePlaybackKey()'),'managed stream discovery must mint an opaque lifecycle key');
assert(!lifecycle.includes("require('./source-admission')"),'managed lifecycle must not depend on commercial stream admission');
assert(!lifecycle.includes('stream_limit'),'managed lifecycle must not inspect a Stremio stream limit');
assert(lifecycle.includes('TRACKING_SECONDS=20'),'managed lifecycle must keep short-lived cleanup tracking');
assert(managedEntitlements.includes('MaxActiveSessions:0'),'hidden Stremio Jellyfin identities must remain unlimited at Jellyfin account policy level');

const hiddenScope=(jellyfinActivity.match(/account_purpose,'jellyfin'\)<>'stremio_internal'/g)||[]).length;
assert(hiddenScope>=2,'generic Jellyfin activity monitoring and revalidation must both exclude stremio_internal identities');

assert(planCreate.includes('stremioHouseholdLeaseMinutes'),'Stremio plan creation must expose its household lease duration');
assert(planCreate.includes('1 Stremio household per subscription'),'plan creation UI must explain household access');
assert(planCreate.includes('one IPv4 address and one IPv6 /64 prefix'),'plan creation UI must explain dual-stack household slots');
assert(plansList.includes("planComponents.accessLabel(plan)"),'admin plan list must use the shared component access label');
assert(storefront.includes("planComponents.accessLabel(plan)"),'storefront must use the shared component access label');
assert(customerStremio.includes("accessModel:'1 Stremio household (IPv4 + IPv6)'")&&!customerStremio.includes('streamLimit:Number('),'Stremio setup model must expose household access rather than a stream allowance');
assert(customerStremio.includes("'/account/stremio/reset-household'"),'customers must be able to reset the Stremio household lease without rotating the install link');
assert(stremioSetup.includes('<%= accessModel %>')&&stremioSetup.includes('1 IPv4 and 1 IPv6 /64')&&stremioSetup.includes('Reset household IP lease'),'Stremio setup page must render the dual-stack access model and reset action');
assert(stremioDashboard.includes('Stremio household'),'Stremio customer dashboard must show household access');
assert(adminCustomer.includes("'/admin/users/:customerId/stremio-household/reset'")&&adminCustomer.includes('Reset Stremio IP lease'),'admins must be able to reset a customer Stremio household lease');

assert(!sourcePool.includes("const http=require('http')")&&!sourcePool.includes('openPlayback('),'external source pool must not contain the retired byte relay');
assert(!jobs.includes('source-admission'),'automation jobs must not maintain retired commercial Stremio admission leases');
for(const retired of ['src/stremio/source-admission.js','src/stremio/managed-session-reconciler.js','src/stremio/source-capability.js','src/stremio/source-playback.js'])assert(!fs.existsSync(path.join(root,retired)),`${retired} must remain removed`);

console.log('stremio household access smoke: ok');
