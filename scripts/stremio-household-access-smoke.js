'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
function read(file){return fs.readFileSync(path.join(root,file),'utf8');}

const runtime=read('src/stremio/runtime.js');
const externalRuntime=read('src/stremio/external-direct-runtime.js');
const householdAccess=read('src/stremio/household-access.js');
const blockedMediaSource=read('src/stremio/blocked-media.js');
const networkIdentity=read('src/access/network-identity.js');
const networkLeases=read('src/access/network-leases.js');
const planComponentsSource=read('src/access/plan-components.js');
const entitlements=read('src/stremio/entitlements.js');
const managedRuntime=read('src/stremio/managed-runtime.js');
const lifecycle=read('src/stremio/managed-playback-lifecycle.js');
const managedEntitlements=read('src/stremio/managed-entitlements.js');
const sourcePool=read('src/stremio/source-pool.js');
const jellyfinActivity=read('src/jellyfin/activity.js');
const stremioPlanCreate=read('src/platform/admin-stremio-plan-create.js');
const stremioPlanEditor=read('src/platform/admin-stremio-plan-editor.js');
const plansList=read('src/platform/admin-plans-list.js');
const storefront=read('src/platform/storefront-core.js');
const customerStremio=read('src/platform/customer-stremio.js');
const adminCustomer=read('src/platform/admin-customer-360.js');
const stremioSetup=read('views/customer/stremio.ejs');
const stremioDashboard=read('views/customer/stremio-dashboard.ejs');
const migration=read('db/migrations/022_retire_stremio_stream_admission.sql');
const familyMigration=read('db/migrations/024_network_lease_families.sql');
const policyMigration=read('db/migrations/026_stremio_household_plan_policy.sql');
const jobs=read('src/automation/jobs.js');
const householdModule=require('../src/stremio/household-access');
const blockedMedia=require('../src/stremio/blocked-media');
const planComponents=require('../src/access/plan-components');

assert(!runtime.includes("require('./source-admission')"),'runtime must not depend on retired commercial source admission');
assert(!runtime.includes('managed-session-reconciler'),'runtime must not start the retired Stremio session-limit reconciler');
assert(!runtime.includes("reason:'stream_limit'")&&!runtime.includes("reason: 'stream_limit'"),'runtime must not emit commercial Stremio stream-limit 429s');
assert(!runtime.includes('X-CAPTAiNFiN-Stream-Active')&&!runtime.includes('X-CAPTAiNFiN-Stream-Limit'),'runtime must not expose retired Stremio stream-count headers');
assert((runtime.match(/reason: 'protocol_rate_limit'/g)||[]).length>=3,'install-token protocol rate limits must remain enabled');
assert(runtime.includes('managedPlayback.startManager({ intervalMs: 5000 })'),'managed playback cleanup manager must remain active');
assert(runtime.includes("householdAccess.claim(entitlement, req"),'playback-start routes must claim the Stremio household network');
assert(runtime.includes('householdAccess.preview(entitlement, req')&&runtime.includes('householdAccess.deniedStream(household,'),'stream result discovery must return a visible home-IP result before source resolution when the IP family is already claimed elsewhere');
assert(runtime.includes("require('./blocked-media')")&&runtime.includes("'/stremio/:token/household-blocked/:type/:videoId.mp4'")&&runtime.includes('blockedMedia.send(req, res)'),'blocked household stream results must point at a playable local MP4 endpoint');
assert(runtime.includes('cachedStreams(entitlement.id, type, videoId, origin)')&&runtime.includes('rememberStreams(entitlement.id, type, videoId, origin, streams)'),'allowed Stremio searches must use a short-lived result cache after household preview');
assert(runtime.includes("'/stremio/:token/external-play/:sourceId/:itemId/:mediaSourceId'"),'external results must have a household-aware playback-start control route');
assert(runtime.includes('const PLAYBACK_REDIRECT_STATUS = 302'),'playback redirects must use a plain temporary redirect for mobile client compatibility');
assert(runtime.includes('return res.redirect(PLAYBACK_REDIRECT_STATUS, target.url)'),'managed playback must end in a Jellyfin redirect');
assert(runtime.includes('return res.redirect(PLAYBACK_REDIRECT_STATUS, target)'),'external playback must end in a direct external Jellyfin redirect');
assert(runtime.includes('CAPTAiNFiN never receives media bytes'),'runtime contract must explicitly remain control-plane only');
assert(householdAccess.includes("scope: 'stremio'")&&householdAccess.includes('return entitlement?.subscription_id || entitlement?.id'),'Stremio household lease must belong to the subscription, not an individual playback');
assert(householdAccess.includes("'household_network'"),'Stremio network denials must be distinguishable from protocol rate limiting');
assert(householdAccess.includes('Outside registered household IP')&&householdAccess.includes('deniedStream')&&householdAccess.includes('bingeGroup')&&householdAccess.includes('videoSize')&&householdAccess.includes('releaseSubject'),'Stremio household denials must produce a playable fake-media result and support explicit lease resets');
assert(householdAccess.includes('stremio_household_network_limit_snapshot')&&householdAccess.includes('stremio_ip_replacement_policy_snapshot'),'runtime access must prefer immutable subscription household snapshots over later plan changes');
assert(householdAccess.includes('replacementState')&&householdAccess.includes('customerInitiated'),'customer-controlled replacement cooldown must be enforced server-side, not only in the portal UI');
const denied=householdModule.deniedStream(
  {networkLimit:1,networkFamily:'ipv4'},
  {url:'https://example.invalid/stremio/token/household-blocked/movie/tt1.mp4',videoSize:blockedMedia.MEDIA_SIZE}
);
assert.match(denied.name,/Outside registered household IP/i,'Stremio denial stream name must make the registered-household-IP block visible in result lists');
assert.match(`${denied.title} ${denied.description}`,/Outside registered household IP.*current IPv4 network is different.*replace your household IP/is,'Stremio denial stream must explain the different-IP block and replacement action');
assert.strictEqual(denied.url,'https://example.invalid/stremio/token/household-blocked/movie/tt1.mp4','Stremio denial stream must point at fake playable media');
assert.strictEqual(denied.externalUrl,undefined,'Stremio denial stream must not be an external-link result that mobile clients can hide');
assert.notStrictEqual(denied.behaviorHints?.notWebReady,true,'fake media is a real MP4 and must not be marked not-web-ready');
assert.strictEqual(denied.behaviorHints?.filename,'CAPTAiNFiN household IP blocked.mp4','fake media stream must carry a readable filename');
assert.strictEqual(denied.behaviorHints?.videoSize,blockedMedia.MEDIA_SIZE,'fake media stream must expose the local MP4 size');
assert(blockedMediaSource.includes('Accept-Ranges')&&blockedMediaSource.includes('Content-Range')&&blockedMediaSource.includes('video/mp4'),'blocked media endpoint must behave like byte-range MP4 playback');
assert.strictEqual(
  blockedMedia.playbackUrl({origin:'https://portal.example',installToken:'tok',type:'series',videoId:'tt123:1:2'}),
  'https://portal.example/stremio/tok/household-blocked/series/tt123%3A1%3A2.mp4',
  'blocked media playback URL must preserve Stremio ids safely'
);
assert.deepStrictEqual(blockedMedia.rangeFor('bytes=0-9',100),{start:0,end:9},'blocked media endpoint must parse explicit byte ranges');
assert.deepStrictEqual(blockedMedia.rangeFor('bytes=-10',100),{start:90,end:99},'blocked media endpoint must parse suffix byte ranges');
assert.strictEqual(blockedMedia.rangeFor('items=0-1',100),false,'blocked media endpoint must reject invalid range units');
assert(blockedMedia.MEDIA_SIZE>10000,'blocked media MP4 asset must be present');
assert(networkIdentity.includes('networkDescriptor')&&networkIdentity.includes("family: canonical.startsWith('ipv4:') ? 'ipv4' : 'ipv6'"),'network identity must expose the normalized IP family without storing raw addresses');
assert(networkIdentity.includes("return `ipv6:${parts.slice(0, 4).join(':')}::/64`"),'temporary IPv6 addresses in the same /64 must normalize to one household network identity');
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

const threeHouseholds=planComponents.stremioHouseholdConfig({stremio_household_network_limit:3,stremio_household_lease_minutes:240,stremio_ip_replacement_policy:'customer_cooldown',stremio_ip_replacement_cooldown_minutes:1440});
assert.strictEqual(threeHouseholds.networkLimit,3,'Stremio household allowance must be configurable per plan');
assert.strictEqual(threeHouseholds.leaseMinutes,1440,'customer cooldown plans must not auto-release a household earlier than the replacement cooldown');
const legacyHousehold=planComponents.stremioHouseholdConfig({stremio_household_network_limit:1,stremio_household_lease_minutes:240,stremio_ip_replacement_policy:'auto_inactive',stremio_ip_replacement_cooldown_minutes:1440});
assert.strictEqual(legacyHousehold.leaseMinutes,240,'upgraded existing plans must preserve their previous inactive-IP lease behaviour');
assert.match(planComponents.accessLabel({service_type:'stremio',stremio_household_network_limit:2,stremio_ip_replacement_policy:'customer_cooldown',stremio_ip_replacement_cooldown_minutes:1440}),/Unlimited streams · Unlimited devices · 2 household IPs/,'shared Stremio labels must sell unlimited streaming and limited households');
assert(planComponentsSource.includes('stremio_household_network_limit'),'shared plan components must read the persisted household allowance rather than hard-coding one');
assert(stremioPlanCreate.includes('1 Household')&&stremioPlanCreate.includes('2 Household')&&stremioPlanCreate.includes('3 Household'),'Stremio plan creation must offer household presets');
assert(stremioPlanCreate.includes('Unlimited streams')&&stremioPlanCreate.includes('Unlimited devices'),'Stremio plan creation must make unlimited playback explicit');
assert(stremioPlanEditor.includes('New purchases only')&&stremioPlanEditor.includes('Existing customers too'),'restrictive Stremio access changes must support scoped customer impact without typed confirmation');
assert(!stremioPlanEditor.includes('Delivery service'),'normal Stremio plan editing must hide internal delivery terminology');
assert(policyMigration.includes("DEFAULT 'customer_cooldown'")&&policyMigration.includes("SET stremio_ip_replacement_policy='auto_inactive'"),'new plans must default to the safer cooldown while upgrades preserve existing plan behaviour');
assert(policyMigration.includes('stremio_household_network_limit_snapshot')&&policyMigration.includes('subscriptions_stremio_household_policy_snapshot'),'household policy must snapshot onto subscriptions for safe grandfathering');
assert(plansList.includes("planComponents.accessLabel(plan)"),'admin plan list must use the shared component access label');
assert(storefront.includes("planComponents.accessLabel(plan)"),'storefront must use the shared component access label');
assert(customerStremio.includes('Unlimited streams · Unlimited devices')&&!customerStremio.includes('streamLimit:Number('),'Stremio setup model must expose unlimited playback and household access rather than a stream allowance');
assert(customerStremio.includes("'/account/stremio/reset-household'")&&customerStremio.includes('customerInitiated:true'),'customer household replacement must use the server-enforced replacement policy');
assert(stremioSetup.includes('<%= accessModel %>')&&!stremioSetup.includes('/64')&&stremioSetup.includes('Replace household IP'),'normal Stremio setup UI must use friendly household wording and hide IPv6 implementation details');
assert(stremioDashboard.includes('Stremio household'),'Stremio customer dashboard must show household access');
assert(adminCustomer.includes("'/admin/users/:customerId/stremio-household/reset'")&&adminCustomer.includes('Reset Stremio IP lease'),'admins must be able to reset a customer Stremio household lease');

assert(!sourcePool.includes("const http=require('http')")&&!sourcePool.includes('openPlayback('),'external source pool must not contain the retired byte relay');
assert(!jobs.includes('source-admission'),'automation jobs must not maintain retired commercial Stremio admission leases');
for(const retired of ['src/stremio/source-admission.js','src/stremio/managed-session-reconciler.js','src/stremio/source-capability.js','src/stremio/source-playback.js'])assert(!fs.existsSync(path.join(root,retired)),`${retired} must remain removed`);

console.log('stremio household access smoke: ok');