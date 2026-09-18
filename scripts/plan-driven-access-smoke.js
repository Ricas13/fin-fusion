'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const lifecyclePolicyRuntime=require('../src/entitlements/jellyfin-lifecycle-policy');
const inactivityRuntime=require('../src/automation/customer-inactivity');
const globalLifecyclePage=require('../src/platform/admin-jellyfin-lifecycle');
const accessEditorRuntime=require('../src/platform/admin-plan-access');
const laneStreamRuntime=require('../src/jellyfin/lane-stream-policy');
const jellyfinPolicyRuntime=require('../src/jellyfin/policy');

const nav=read('src/platform/admin-nav.js');
const application=read('src/application.js');
const composition=read('src/platform/admin-route-composition.js');
const createPlan=read('src/platform/admin-plan-create-v2.js');
const lifecyclePolicySource=read('src/entitlements/jellyfin-lifecycle-policy.js');
const inactivityScoped=read('src/automation/customer-inactivity-scoped.js');
const inactivity=read('src/automation/customer-inactivity.js');
const subscriptionState=read('src/entitlements/subscription-state.js');
const cleanupReturn=read('src/entitlements/jellyfin-cleanup-return.js');
const resilientProvisioning=read('src/jellyfin/resilient-provisioning.js');
const lifecycle=read('src/payments/lifecycle.js');
const storefront=read('src/platform/storefront.js');
const serverUsers=read('src/platform/admin-server-users.js');
const serverForm=read('views/admin/server-form.ejs');
const serverLibraries=read('src/platform/admin-server-library-dashboard.js');
const plansList=read('src/platform/admin-plans-list.js');
const planLifecycleSource=read('src/platform/admin-jellyfin-plan-editor.js');
const globalLifecycleSource=read('src/platform/admin-jellyfin-lifecycle.js');
const planAccessSource=read('src/platform/admin-plan-access.js');
const planAccessClient=read('public/js/admin-plan-access.js');
const navigationCoherence=read('public/js/admin-navigation-coherence.js');
const laneStreamSource=read('src/jellyfin/lane-stream-policy.js');
const devicePolicySource=read('src/jellyfin/device-access-policy.js');

// Customers owns customer records and Jellyfin import/claim discovery. Invitation
// onboarding is retired; imported-user claims remain a subordinate import flow.
assert(nav.includes("['jellyfin-import','Import from Jellyfin'"),'Jellyfin import must remain discoverable under Customers with the canonical explicit label');
assert(!nav.includes("['invitations','Invitations'"),'Retired Invitations must not return to Customers navigation');
assert(nav.includes("'customer-claims':Object.freeze")&&nav.includes("['customer-claims','Imported-user claims'"),'Imported-user claims must remain addressable from the Jellyfin Import workflow');
assert(nav.includes("['users','All customers','/admin/users']")&&nav.includes("['activity','Playback','/admin/activity']"),'All customers and Playback must remain visible operator starting points in the fixed rail');
assert(nav.includes("['referrals','Affiliates','/admin/referrals']"),'Affiliate administration must remain a permanent Commerce destination');

// New customer plans are inventory-controlled and Jellyfin plans expose the real
// media policy surface. Lifecycle/inactivity is no longer a per-plan setting.
for(const token of ['capacityLimit','streams','allowDownloads','allowVideoTranscoding','allowAudioTranscoding','allowRemuxing','allowLiveTv','allowLiveTvManagement','allowRemoteAccess','libraryAccessMode','libraryNames'])assert(createPlan.includes(token),`New plan is missing ${token}`);
assert(createPlan.includes('allow_4k'),'New Jellyfin plans must persist the existing 4K catalogue flag');
assert(createPlan.includes('allowSubtitleEditing')&&createPlan.includes("'Edit subtitles'"),'New Jellyfin plans must expose the real Jellyfin subtitle-management permission');
for(const retired of ['inactivityEnabled','minimumPlaybackMinutes','noPlaybackDays'])assert(!createPlan.includes(retired),`Plan creation must not expose retired lifecycle field ${retired}`);
assert(!planLifecycleSource.includes('name="_lifecycleCheckboxes"'),'Unified plan editor must not render per-plan lifecycle controls');
assert(!planLifecycleSource.includes("editor-lifecycle"),'Unified plan editor must not own a per-plan lifecycle save action');
assert(!fs.existsSync(path.join(root,'src/entitlements/plan-lifecycle-policy.js')),'Retired plan-level inactivity policy module must stay removed');

// Global lifecycle settings own execution mode only. Thresholds are server-owned.
assert.deepStrictEqual(lifecyclePolicyRuntime.normalize({enabled:true,dryRun:false,freeNoPlaybackDays:99,minimumPlaybackMinutes:999}),{enabled:true,dryRun:false},'Global lifecycle policy must ignore retired threshold fields');
assert(lifecyclePolicySource.includes("const DEFAULTS = Object.freeze({ enabled: true, dryRun: false })"),'Global lifecycle defaults must contain execution switches only');
for(const field of ['free_first_playback_grace_days','free_playback_window_days','free_minimum_playback_minutes'])assert(inactivity.includes(field),`Free inactivity worker must read server-owned threshold ${field}`);
assert(inactivity.includes("lifecyclePolicy = require('../entitlements/jellyfin-lifecycle-policy')")||inactivity.includes("lifecyclePolicy=require('../entitlements/jellyfin-lifecycle-policy')"),'Free inactivity worker must use the global execution-mode owner');
assert(!inactivity.includes('planPolicy.')&&!inactivity.includes("plan-lifecycle-policy"),'Free inactivity worker must not recreate a plan-level policy layer');
assert(!inactivity.includes("COALESCE((p.inactivity_policy->>'enabled')::boolean,FALSE)=TRUE"),'Free candidates must not require a per-plan enabled flag');
assert(!inactivity.includes("s.source='free_claim'"),'Free inactivity must apply to the canonical Free entitlement regardless of acquisition source');
assert(subscriptionState.includes("h.hold_type='inactivity_policy'")&&subscriptionState.includes("h.source_key=('plan:'||$2::text)"),'Free entitlement lookup must honor inactivity holds independently of subscription source');
assert(subscriptionState.includes("h.hold_type='jellyfin_cleanup'")&&subscriptionState.includes("ja.access_lane='free'"),'Dormant cleanup blocking must remain scoped to the Free Jellyfin lane');

// The global lifecycle page is execution-only and points threshold editing to Free Servers.
assert(globalLifecycleSource.includes('name="_lifecycleCheckboxes" value="1"')&&globalLifecycleSource.includes('lifecycleFormInput(req.body)'),'Global lifecycle form must explicitly mark browser checkbox submissions');
assert(globalLifecycleSource.includes('Thresholds belong to each Free-class media server')&&globalLifecycleSource.includes('Free Server settings'),'Global lifecycle UI must direct threshold ownership to Free Servers');
assert(!globalLifecycleSource.includes('freeNoPlaybackDays')&&!globalLifecycleSource.includes('minimumPlaybackMinutes'),'Global lifecycle UI must not expose retired global thresholds');
const globalUnchecked=globalLifecyclePage.lifecycleFormInput({_lifecycleCheckboxes:'1'});
assert.strictEqual(globalUnchecked.enabled,false,'Unticking global lifecycle automation must persist explicit false');
assert.strictEqual(globalUnchecked.dryRun,false,'Unticking global dry run must persist explicit false');
const globalChecked=globalLifecyclePage.lifecycleFormInput({_lifecycleCheckboxes:'1',enabled:'on',dryRun:'on'});
assert.strictEqual(globalChecked.enabled,'on');
assert.strictEqual(globalChecked.dryRun,'on');

// Free inactivity has exactly two rules and is scoped to the current allocation.
const now=Date.UTC(2026,8,12,12,0,0),day=86400000;
const usagePolicy={enabled:true,dryRun:false,firstPlaybackGraceDays:3,playbackWindowDays:7,minimumPlaybackMinutes:30};
const recentAllocation=inactivityRuntime.assessUsage({allocation_start_at:new Date(now-2*day),last_playback_at:null,first_playback_at:null,playback_seconds:0},usagePolicy,now);
assert.strictEqual(recentAllocation.firstPlaybackEligible,false,'A new Free allocation must retain its full first-play grace period');
assert.strictEqual(recentAllocation.usageEligible,false,'The rolling-minutes rule cannot run before first playback');
const missedFirstPlay=inactivityRuntime.assessUsage({allocation_start_at:new Date(now-4*day),last_playback_at:null,first_playback_at:null,playback_seconds:0},usagePolicy,now);
assert.strictEqual(missedFirstPlay.firstPlaybackEligible,true,'Rule 1 must make an allocation eligible after its first-play grace expires');
const oldPlayback=inactivityRuntime.assessUsage({allocation_start_at:new Date(now-4*day),first_playback_at:new Date(now-10*day),last_playback_at:new Date(now-10*day),playback_seconds:60*60},usagePolicy,now);
assert.strictEqual(oldPlayback.hasPlayback,false,'Playback before the current allocation must not activate a newly allocated Free place');
assert.strictEqual(oldPlayback.firstPlaybackEligible,true,'Pre-allocation playback must not prevent the first-play rule');
const lowUsage=inactivityRuntime.assessUsage({allocation_start_at:new Date(now-10*day),first_playback_at:new Date(now-9*day),last_playback_at:new Date(now-2*day),playback_seconds:29*60},usagePolicy,now);
assert.strictEqual(lowUsage.firstPlaybackOnTime,true,'An on-time first playback must activate the allocation');
assert.strictEqual(lowUsage.usageEligible,true,'Rule 2 must apply after one full rolling window when watched minutes are below the server minimum');
const enoughUsage=inactivityRuntime.assessUsage({allocation_start_at:new Date(now-10*day),first_playback_at:new Date(now-9*day),last_playback_at:new Date(now-2*day),playback_seconds:31*60},usagePolicy,now);
assert.strictEqual(enoughUsage.usageEligible,false,'Meeting the rolling watched-minutes threshold must preserve Free access');
const latePlayback=inactivityRuntime.assessUsage({allocation_start_at:new Date(now-10*day),first_playback_at:new Date(now-6*day),last_playback_at:new Date(now-1*day),playback_seconds:60*60},usagePolicy,now);
assert.strictEqual(latePlayback.firstPlaybackOnTime,false,'A first playback after the activation deadline must remain late');
assert.strictEqual(latePlayback.firstPlaybackEligible,true,'Late playback must not retroactively rescue a missed first-play deadline');
assert.strictEqual(latePlayback.usageEligible,false,'The rolling-minutes rule must not replace the missed first-play rule');
assert(inactivity.includes('repairExistingHold: Boolean(row.already_held && eligible)')||inactivity.includes('repairExistingHold:Boolean(row.already_held&&eligible)'),'Held-but-present Free accounts must remain retryable after a failed exact-account deletion');
assert(inactivity.includes('!row.currently_playing'),'A currently playing Free account must never be selected for inactivity removal');

// Portal identity is never an inactivity target; automation touches Jellyfin access/user only.
// The dormant-account cleanup pipeline that used to live in this module (getCleanup/
// saveCleanup/cleanupCandidates/deleteDormantAccount/runCleanup) was dead code - never
// wired to any cron job or route - and was unsafe by construction. It has been removed.
// The live inactivity path now locks the customer, rechecks the exact Free account and
// entitlement, revalidates server playback trust, then calls the exact-account delete
// primitive directly. It never invokes broad customer reconciliation for removal.
assert(inactivity.includes("HOLD_TYPE = 'inactivity_policy'")||inactivity.includes("HOLD_TYPE='inactivity_policy'"),'Lifecycle actions must use an explicit Jellyfin hold');
assert(!inactivity.includes('CLEANUP_HOLD_TYPE')&&!inactivity.includes('cleanupCandidates')&&!inactivity.includes('deleteDormantAccount')&&!inactivity.includes('runCleanup'),'The unsafe, unguarded dormant-account cleanup pipeline must not return to this module');
const engineCore=read('src/jellyfin/provisioning-engine.js');
assert(inactivityScoped.includes('provisioning.deleteJellyfinAccount')&&!inactivityScoped.includes('provisioning.reconcileCustomer(row.customer_id)'),'Free inactivity removal must target only the exact account, not run broad reconciliation');
assert(inactivityScoped.includes('requireNoActivePlayback: true'),'Automatic inactivity deletion must request a live playback precondition');
assert(engineCore.includes('assertNoActivePlaybackBeforeDelete')&&engineCore.includes("registry.request(account.server_id, '/Sessions'"),'The destructive boundary must recheck live Jellyfin sessions');
assert(engineCore.includes('/Users/${encodeURIComponent(account.jellyfin_user_id)}')&&engineCore.includes("method: 'DELETE'"),'The canonical delete path must delete the Jellyfin user remotely');
assert(engineCore.includes('DELETE FROM jellyfin_accounts WHERE id=$1'),'The canonical delete path must remove only the local Jellyfin account mapping');
assert(!engineCore.includes('disabledInstead'),'The canonical delete path must never fall back to a disabled state');
assert(!/DELETE\s+FROM\s+customers/i.test(inactivity+inactivityScoped),'Inactivity automation must never delete CAPTAiNFiN customers');
assert(!/UPDATE\s+app_users\s+SET\s+active\s*=\s*FALSE/i.test(inactivity+inactivityScoped),'Inactivity automation must never deactivate portal logins');
assert(cleanupReturn.includes('includeBlocked:true'),'Portal return must be able to see through the cleanup hold');
assert(cleanupReturn.includes('hold_type=$2')&&cleanupReturn.includes("CLEANUP_HOLD_TYPE='jellyfin_cleanup'"),'Portal return must release only cleanup holds');
assert(resilientProvisioning.includes('releaseObsoleteForCustomer(customerId)'),'Every canonical Jellyfin reconcile must discard obsolete free-plan inactivity holds');
assert(lifecycle.includes('await inactivityHolds.releaseObsoleteForCustomer(input.customerId)'),'Paid activation must release an obsolete free-plan hold immediately after commit');

// Server-scoped user import owns execution even though Customers exposes the entry point.
assert(serverForm.includes('Users / Import')&&serverForm.includes('/users'),'Each Jellyfin server must expose Users / Import in its local tabs');
assert(serverForm.includes('Customer capacity'),'Jellyfin server configuration must expose the shared storefront customer-capacity budget');
assert(serverUsers.includes("'/admin/servers/:serverId/users'")&&serverUsers.includes('importer.discover({serverId:s.id})'),'Import must be scoped to exactly one Jellyfin server');
assert(serverUsers.includes("'/admin/jellyfin-import'")&&serverUsers.includes('res.send(await importLanding(req))'),'Global Jellyfin Import must render the server-picker landing page');
assert(serverUsers.includes('Choose Jellyfin server')&&serverUsers.includes('/admin/servers/${esc(s.id)}/users'),'Jellyfin Import landing must guide the operator into a server-scoped import');
assert(serverLibraries.includes("serverTabs(data.server.id,'libraries')"),'Libraries reached from a server must retain server tab context');

// Storefront remains plan-first and sold-out products stay visible.
for(const removed of ['Everything you need to watch your way','Your account follows you from screen to screen','From account to watching in minutes'])assert(!storefront.includes(removed),`Removed storefront section returned: ${removed}`);
assert(storefront.includes('serviceCatalog.storefrontSections(plans)')&&storefront.includes("section.serviceType==='jellyfin'")&&storefront.includes("section.serviceType==='stremio'")&&storefront.includes("section.serviceType==='emby'"),'Storefront must retain catalogue-driven Jellyfin, Stremio and Emby service sections');
assert(storefront.includes('Currently full')&&storefront.includes("sold?'soldOut':''")&&storefront.includes('planAvailability'),'Sold-out product cards must remain visible, use the real scarcity state and be visually disabled');
assert(plansList.includes('capacityMeter')&&plansList.includes('Manage customer availability'),'Unified Plans must expose customer availability state and its management entry point');
assert(plansList.includes('customers} ${plural(customers,\'customer\')} on this plan')&&plansList.includes('new ${plural(remaining,\'place\')} available')&&plansList.includes("sectionTable('paid', 'Jellyfin Shares'")&&plansList.includes("sectionTable('emby', 'Emby Shares'")&&plansList.includes("sectionTable('stremio', 'Stremio Shares'"),'Unified Plans must present availability in customer terms and keep the service share families explicit');

// Current workflow routes own customer-plan and server actions.
assert(composition.includes('createAdminPlanCreateV2Router()'),'Full-policy plan creation must be mounted');
assert(!composition.includes('createAdminCatalogShellRouter'),'Legacy catalogue create routes must not be mounted alongside the V2 plan-create owner');
assert(composition.includes('createAdminCustomerCreateRouter()'),'The non-plan Add Customer route must remain available after removing the legacy catalogue router');
assert(composition.includes('createLegacyJellyfinImportRedirectRouter()')&&!composition.includes('createAdminJellyfinImportRouter'),'Only the server-guidance landing route may own the legacy Jellyfin Import URL');
assert(composition.includes('createAdminServerUsersRouter()')&&composition.includes('createAdminJellyfinPlanEditorRouter()')&&composition.includes('createAdminPlanInventoryRouter()'),'Unified Jellyfin plan/inventory and server import routes must be mounted');

// Jellyfin/Emby playback limits must be independently selectable. Explicit 0
// is the persisted "unlimited/off" sentinel for concurrent streams, while bad
// legacy data still falls back to the conservative one-stream default.
const jellyfinPlan={service_type:'jellyfin',streams:1};
assert.strictEqual(accessEditorRuntime.parse(jellyfinPlan,{streams:'0',jellyfinAccessModel:'concurrent_streams'}).streams,0,'Jellyfin plans must accept 0 concurrent streams as unlimited');
const entitlementMap=new Map([['customer-1:primary',{streams:0}]]);
assert.strictEqual(laneStreamRuntime.effectiveStreamLimit({customer_id:'customer-1',access_lane:'primary'},entitlementMap,new Map()),null,'an explicit plan stream value of 0 must disable concurrent-stream enforcement');
assert.strictEqual(laneStreamRuntime.effectiveStreamLimit({customer_id:'customer-1',access_lane:'primary'},new Map([['customer-1:primary',{streams:2}]]),new Map()),2,'positive concurrent-stream limits must remain enforced');
assert.strictEqual(laneStreamRuntime.effectiveStreamLimit({customer_id:'customer-1',access_lane:'primary'},new Map([['customer-1:primary',{streams:'broken'}]]),new Map()),1,'malformed legacy stream data must retain the conservative fallback');
assert.strictEqual(jellyfinPolicyRuntime.effectiveTechnicalPolicy({streams:0,jellyfin_access_model:'household_network'},null).streams.effective,0,'legacy household mode must not erase the independent concurrent-stream setting');
assert(planAccessSource.includes("int(body.streams, 0, 50, 'Concurrent streams')"),'plan access persistence must accept the unlimited stream sentinel');
assert(planAccessClient.includes("input.min='0'")&&planAccessClient.includes("el.hidden=false"),'the unified browser editor must expose concurrent streams independently and permit 0=unlimited');
assert(navigationCoherence.includes("loadScript('/js/admin-plan-access.js','data-admin-plan-access')"),'the unified Jellyfin plan editor must load the independent access enhancer');
assert(laneStreamSource.includes('if (Number(raw) === 0) return null;'),'runtime stream enforcement must skip only the explicit unlimited sentinel');

// Persistent device slots stay open until all configured slots are claimed.
// Otherwise a 25-device plan would close Jellyfin/Emby native device access
// after the first registration and the remaining 24 devices could never join.
const underCapacity=devicePolicySource.indexOf('if (ids.length < limit)');
const nativeAllowlist=devicePolicySource.indexOf('const applied = await applyRemoteAllowlist(account, ids);');
assert(underCapacity>=0&&nativeAllowlist>underCapacity,'native media-server device allowlisting must happen only after the configured persistent slots are full');
assert(devicePolicySource.includes('awaitingAdditionalDevices: true'),'under-capacity device policies must deliberately keep the native allowlist open for later slot claims');

console.log('plan-driven access lifecycle smoke: ok');