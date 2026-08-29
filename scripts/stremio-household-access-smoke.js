'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const runtime=read('src/stremio/runtime.js');
const externalRuntime=read('src/stremio/external-direct-runtime.js');
const householdAccess=read('src/stremio/household-access.js');
const blockedMediaSource=read('src/stremio/blocked-media.js');
const networkIdentity=read('src/access/network-identity.js');
const networkLeases=read('src/access/network-leases.js');
const planComponentsSource=read('src/access/plan-components.js');
const entitlements=read('src/stremio/entitlements.js');
const managedRuntime=read('src/stremio/managed-runtime.js');
const managedEntitlements=read('src/stremio/managed-entitlements.js');
const sourcePool=read('src/stremio/source-pool.js');
const jellyfinActivity=read('src/jellyfin/activity.js');
const stremioPlanEditor=read('src/platform/admin-stremio-plan-editor.js');
const plansList=read('src/platform/admin-plans-list.js');
const storefront=read('src/platform/storefront-core.js');
const customerStremio=read('src/platform/customer-stremio.js');
const customerDashboard=read('src/platform/customer-dashboard.js');
const dashboard=read('views/customer/dashboard.ejs');
const adminCustomer=read('src/platform/admin-customer-360.js');
const migration=read('db/migrations/022_retire_stremio_stream_admission.sql');
const familyMigration=read('db/migrations/024_network_lease_families.sql');
const policyMigration=read('db/migrations/026_stremio_household_plan_policy.sql');
const jobs=read('src/automation/jobs.js');
const householdModule=require('../src/stremio/household-access');
const blockedMedia=require('../src/stremio/blocked-media');
const planComponents=require('../src/access/plan-components');

// Unlimited playback remains the runtime contract. Household admission is the
// only commercial Stremio access limit; protocol abuse controls stay separate.
assert(!runtime.includes("require('./source-admission')"),'retired Stremio stream admission must stay removed');
assert(!runtime.includes('managed-session-reconciler')&&!runtime.includes('X-CAPTAINFiN-Stream-Limit'),'runtime must not reintroduce commercial stream counting');
assert((runtime.match(/reason: 'protocol_rate_limit'/g)||[]).length>=3,'protocol abuse rate limits must remain enabled');
assert(runtime.includes("householdAccess.claim(entitlement, req")&&runtime.includes('householdAccess.preview(entitlement, req'),'Stremio playback must still claim and preview household access');
assert(runtime.includes("householdAccess.claim(entitlement, req, { kind: 'direct_stream_result' })"),'household access must be claimed before direct authenticated Jellyfin URLs are returned');
assert(runtime.includes("require('./blocked-media')")&&runtime.includes('blockedMedia.send(req, res)'),'household denial must retain the playable local block-media path added on main');
assert(runtime.includes('never receives or relays the media bytes'),'runtime must remain control-plane only');
assert(!externalRuntime.includes('pipe(res)')&&!runtime.includes('pipe(res)'),'CAPTAiNFiN must never relay Stremio media bytes');
assert(!runtime.includes("require('./managed-playback-lifecycle')")&&!managedRuntime.includes('/PlaybackInfo'),'raw Stremio delivery must not create a Jellyfin playback-session lifecycle');
assert(!fs.existsSync(path.join(root,'src/stremio/managed-playback-lifecycle.js')),'retired managed playback lifecycle module must stay removed');
assert(runtime.indexOf("householdAccess.preview(entitlement, req, { kind: 'stream_results' })")<runtime.indexOf('Promise.allSettled(['),'outside-household checks must happen before any source search/result resolution');
assert(runtime.includes('if (preview && preview.allowed === false) return res.json(await deniedStreamResponse'),'a denied household search must return a Stremio result payload instead of an empty stream list');

// Household identity is privacy-preserving and IPv6 temporary addresses are
// normalized to the connection's /64 rather than counted independently.
assert(networkIdentity.includes("if (version === 4) return `ipv4:${address}`"),'one IPv4 address must map to one household identity');
assert(networkIdentity.includes("return `ipv6:${groups.slice(0, 4).join(':')}::/64`"),'one IPv6 /64 must map to one household identity');
assert(networkIdentity.includes("family: canonical.startsWith('ipv4:') ? 'ipv4' : 'ipv6'"),'normalized identities must preserve address family');
assert(networkLeases.includes('network_family')&&networkLeases.includes('activeSameFamily'),'dual-stack household slots must continue to be enforced per address family');
assert(familyMigration.includes('access_network_leases_subject_family_idx'),'dual-stack lease lookup migration must remain present');
assert(networkLeases.includes("decision === 'denied'")&&networkLeases.includes("INTERVAL '5 minutes'"),'repeated denied polling must remain audit-throttled');
const claimLeaseScope=networkLeases.slice(networkLeases.indexOf('async function claim'),networkLeases.indexOf('async function preview'));
const releaseLeaseScope=networkLeases.slice(networkLeases.indexOf('async function releaseSubject'),networkLeases.indexOf('async function cleanupExpired'));
assert(!claimLeaseScope.includes('DELETE FROM access_network_leases'),'Stremio household claims must not require web-role DELETE on network leases');
assert(releaseLeaseScope.includes('UPDATE access_network_leases SET expires_at=NOW()')&&!releaseLeaseScope.includes('DELETE FROM access_network_leases'),'customer/admin household reset must expire leases using web-role UPDATE rather than DELETE');

// The household denial is an ordinary Stremio stream result backed by a local
// MP4. HTTPS MP4 is web-ready: marking it notWebReady causes Stremio Web to
// discard the only explanatory result and show its generic no-streams message.
assert(householdAccess.includes('bingeGroup')&&householdAccess.includes('videoSize'),'denied results must retain blocked-media playback hints');
assert(householdAccess.includes('blockedMediaIsWebReady')&&householdAccess.includes("url.protocol === 'https:'"),'denied result visibility must distinguish a web-ready HTTPS MP4 from non-web-ready fallback URLs');
const denied=householdModule.deniedStream({networkLimit:1,networkFamily:'ipv4'},{url:'https://example.invalid/stremio/token/household-blocked/movie/tt1.mp4',videoSize:blockedMedia.MEDIA_SIZE});
assert.match(`${denied.title} ${denied.description}`,/Household IP limit reached.*allowed household internet connections.*change your household connection/is,'denial copy must explain the household-connection replacement action');
assert.strictEqual(denied.url,'https://example.invalid/stremio/token/household-blocked/movie/tt1.mp4','denied result must point at the local MP4 endpoint');
assert.strictEqual(denied.behaviorHints?.notWebReady,false,'HTTPS MP4 household denial must remain visible to Stremio Web');
assert.strictEqual(denied.behaviorHints?.filename,'CAPTAiNFiN household connection blocked.mp4','blocked result must keep its readable media filename');
assert.strictEqual(denied.behaviorHints?.videoSize,blockedMedia.MEDIA_SIZE,'blocked result must expose the local MP4 size');
const insecureDenied=householdModule.deniedStream({networkLimit:1},{url:'http://example.invalid/stremio/token/household-blocked/movie/tt1.mp4'});
assert.strictEqual(insecureDenied.behaviorHints?.notWebReady,true,'non-HTTPS fallback block media must stay marked non-web-ready');
assert(blockedMediaSource.includes('Accept-Ranges')&&blockedMediaSource.includes('Content-Range')&&blockedMediaSource.includes('video/mp4'),'block-media endpoint must continue to support byte ranges');
assert(blockedMedia.MEDIA_SIZE>10000,'block-media asset must remain present');

// The persisted stream field is compatibility-only and hidden Stremio
// identities remain unlimited at Jellyfin policy level.
assert(entitlements.includes('function streamLimit(_row){return 1;}'),'stream_limit must remain a compatibility sentinel only');
assert(migration.includes('SET stream_limit=1'),'existing Stremio entitlement rows must remain normalized to the sentinel');
assert(!managedRuntime.includes("require('./source-admission')"),'managed playback must not enforce a commercial stream allowance');
assert(managedEntitlements.includes('MaxActiveSessions:0'),'hidden Stremio Jellyfin identities must remain unlimited');
const hiddenScope=(jellyfinActivity.match(/account_purpose,'jellyfin'\)<>'stremio_internal'/g)||[]).length;
assert(hiddenScope>=2,'generic Jellyfin activity paths must keep excluding internal Stremio identities');

// Household policy: configurable allowance, unlimited streams/devices, safe
// default cooldown, and durable subscription snapshots for runtime lookup.
const threeHouseholds=planComponents.stremioHouseholdConfig({stremio_household_network_limit:3,stremio_household_lease_minutes:240,stremio_ip_replacement_policy:'customer_cooldown',stremio_ip_replacement_cooldown_minutes:1440});
assert.strictEqual(threeHouseholds.networkLimit,3,'Stremio household allowance must be configurable');
assert.strictEqual(threeHouseholds.leaseMinutes,1440,'customer cooldown must prevent automatic replacement before the cooldown');
const legacy=planComponents.stremioHouseholdConfig({stremio_household_network_limit:1,stremio_household_lease_minutes:240,stremio_ip_replacement_policy:'auto_inactive',stremio_ip_replacement_cooldown_minutes:1440});
assert.strictEqual(legacy.leaseMinutes,240,'upgraded plans must preserve prior inactive-IP replacement behavior');
assert.match(planComponents.accessLabel({service_type:'stremio',stremio_household_network_limit:2,stremio_ip_replacement_policy:'customer_cooldown',stremio_ip_replacement_cooldown_minutes:1440}),/Unlimited streams · Unlimited devices · 2 household connections/,'shared Stremio labels must sell unlimited streaming with limited household connections');
assert(planComponentsSource.includes('stremio_household_network_limit'),'plan components must read the persisted household limit');
assert(householdAccess.includes('stremio_household_network_limit_snapshot')&&householdAccess.includes('stremio_ip_replacement_policy_snapshot'),'runtime must prefer subscription policy snapshots');
assert(householdAccess.includes('replacementState')&&householdAccess.includes('customerInitiated'),'replacement cooldown must be enforced server-side');
assert(policyMigration.includes("DEFAULT 'customer_cooldown'")&&policyMigration.includes("SET stremio_ip_replacement_policy='auto_inactive'"),'new plans must default to cooldown while existing plans preserve old behavior');
assert(policyMigration.includes('stremio_household_network_limit_snapshot')&&policyMigration.includes('subscriptions_stremio_household_policy_snapshot'),'subscription snapshots must persist effective household policy on each contract');

// Admin/customer UX must describe the product in customer terms, not delivery
// architecture or IPv6 implementation details. Plan edits are authoritative for
// every current plan member; stale/new-purchases-only grandfathering is retired.
assert(!fs.existsSync(path.join(root,'src/platform/admin-stremio-plan-create.js')),'retired standalone Stremio plan creator must stay removed; adaptive plan creation owns this flow');
assert(!stremioPlanEditor.includes('New purchases only')&&!stremioPlanEditor.includes('Existing customers too'),'Stremio plan edits must not offer stale-policy grandfathering for current members');
assert(stremioPlanEditor.includes("updateTrackingSnapshots(client,data.plan,input,impact,'all_current')")&&stremioPlanEditor.includes('queuePlanRequestReconciliation'),'Stremio access edits must update all current household snapshots and queue current members for request-policy reconciliation');
assert(stremioPlanEditor.includes("UPDATE access_network_leases SET expires_at=NOW() WHERE scope='stremio'")&&!stremioPlanEditor.includes("DELETE FROM access_network_leases WHERE scope='stremio'"),'changed household policy must expire current Stremio leases without requiring web-role DELETE');
assert(!stremioPlanEditor.includes('Delivery service'),'normal Stremio editor must hide delivery internals');
assert(plansList.includes('planComponents.accessLabel(plan)')&&storefront.includes('planComponents.accessLabel(plan)'),'admin/storefront Stremio labels must share the household-aware formatter');
assert(customerDashboard.includes('Unlimited streams · Unlimited devices')&&customerStremio.includes('customerInitiated:true'),'Account Home must own unlimited playback copy while customer Stremio routes retain server-enforced household replacement');
assert(customerDashboard.includes('stremioHouseholdForCustomer')&&customerDashboard.includes('householdAccess.replacementState'),'Account Home must load the current Stremio household state');
assert(dashboard.includes('<%= stremioHousehold.accessModel %>')&&!dashboard.includes('/64')&&dashboard.includes('Use a different household connection'),'Account Home Stremio UI must show household access without exposing network implementation detail and retain the household replacement control');
assert(!fs.existsSync(path.join(root,'views/customer/stremio.ejs')),'retired standalone Stremio setup view must stay removed');
assert(adminCustomer.includes("'/admin/users/:customerId/stremio-household/reset'"),'admin household reset support must remain available');

assert(!sourcePool.includes("const http=require('http')")&&!sourcePool.includes('openPlayback('),'retired source byte relay must stay removed');
assert(!jobs.includes('source-admission'),'automation must not maintain retired stream-admission leases');
for(const retired of ['src/stremio/source-admission.js','src/stremio/managed-session-reconciler.js','src/stremio/source-capability.js','src/stremio/source-playback.js'])assert(!fs.existsSync(path.join(root,retired)),`${retired} must remain removed`);

console.log('stremio household access smoke: ok');
