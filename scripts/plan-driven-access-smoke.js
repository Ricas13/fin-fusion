'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const planPolicyRuntime=require('../src/entitlements/plan-lifecycle-policy');
const inactivityRuntime=require('../src/automation/customer-inactivity');
const planLifecyclePage=require('../src/platform/admin-jellyfin-plan-editor');
const globalLifecyclePage=require('../src/platform/admin-jellyfin-lifecycle');
const accessEditorRuntime=require('../src/platform/admin-plan-access');
const laneStreamRuntime=require('../src/jellyfin/lane-stream-policy');
const jellyfinPolicyRuntime=require('../src/jellyfin/policy');

const nav=read('src/platform/admin-nav.js');
const application=read('src/application.js');
const composition=read('src/platform/admin-route-composition.js');
const createPlan=read('src/platform/admin-plan-create-v2.js');
const planPolicy=read('src/entitlements/plan-lifecycle-policy.js');
const inactivity=read('src/automation/customer-inactivity.js');
const subscriptionState=read('src/entitlements/subscription-state.js');
const cleanupReturn=read('src/entitlements/jellyfin-cleanup-return.js');
const provisioning=read('src/jellyfin/provisioning.js');
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
assert(nav.includes("['users','Customers','/admin/users']")&&nav.includes("['activity','Playback','/admin/activity']"),'Customers and Jellyfin Playback must remain visible operator starting points in the condensed navigation');
assert(nav.includes("referrals:Object.freeze")&&nav.includes("['referrals','Affiliates','/admin/referrals']")&&nav.includes("parentKey:'orders'"),'Affiliate administration must remain addressable contextually from Orders & Growth');

// New customer plans are inventory-controlled and Jellyfin plans expose the real policy surface.
for(const token of ['capacityLimit','streams','allowDownloads','allowVideoTranscoding','allowAudioTranscoding','allowRemuxing','allowLiveTv','allowLiveTvManagement','allowRemoteAccess','libraryAccessMode','libraryNames'])assert(createPlan.includes(token),`New plan is missing ${token}`);
assert(createPlan.includes('allow_4k'),'New Jellyfin plans must persist the existing 4K catalogue flag');
assert(createPlan.includes('allowSubtitleEditing')&&createPlan.includes("'Edit subtitles'"),'New Jellyfin plans must expose the real Jellyfin subtitle-management permission');
assert(createPlan.includes('inactivityEnabled')&&createPlan.includes('minimumPlaybackMinutes')&&createPlan.includes('noPlaybackDays'),'Free plan creation must include configurable Jellyfin usage rules');
assert(planPolicy.includes("billing_interval||'')==='trial'"),'Plan usage disabling must explicitly exclude trial plans');
const inheritedPolicy=planPolicyRuntime.effectiveForFreePlan({},{enabled:true,dryRun:false,freeNoPlaybackDays:7});
assert.strictEqual(inheritedPolicy.enabled,true,'Free plan with no lifecycle override must inherit globally enabled automation');
assert.strictEqual(inheritedPolicy.dryRun,false,'Free plan with no lifecycle override must inherit global enforcement mode');
assert.strictEqual(inheritedPolicy.noPlaybackDays,7,'Free plan with no lifecycle override must inherit global no-playback threshold');
assert.strictEqual(planPolicyRuntime.hasUsageTrigger(inheritedPolicy),true,'Inherited Free rule must be an actionable usage policy');
const explicitlyDisabled=planPolicyRuntime.effectiveForFreePlan({enabled:false,dryRun:false,noPlaybackDays:7},{enabled:true,dryRun:false,freeNoPlaybackDays:7});
assert.strictEqual(explicitlyDisabled.enabled,false,'Explicit per-plan disable must override a globally enabled lifecycle');
const globallyDry=planPolicyRuntime.effectiveForFreePlan({enabled:true,dryRun:false,noPlaybackDays:3},{enabled:true,dryRun:true,freeNoPlaybackDays:7});
assert.strictEqual(globallyDry.dryRun,true,'Global dry-run must prevent a plan override from forcing enforcement');
assert(inactivity.includes("lifecyclePolicy=require('../entitlements/jellyfin-lifecycle-policy')")&&inactivity.includes('planPolicy.effectiveForFreePlan'),'Free inactivity worker must resolve the effective global-plus-plan lifecycle policy');
assert(!inactivity.includes("COALESCE((p.inactivity_policy->>'enabled')::boolean,FALSE)=TRUE"),'Free candidates must not be silently excluded just because their plan has no explicit enabled override');
assert(!inactivity.includes("s.source='free_claim'"),'Free inactivity must apply to the canonical Free entitlement regardless of acquisition source');
assert(subscriptionState.includes("h.hold_type='inactivity_policy'")&&subscriptionState.includes("h.source_key=('plan:'||$2::text)"),'Free entitlement lookup must honor plan-scoped inactivity holds independently of subscription source');
assert(subscriptionState.includes("h.hold_type='jellyfin_cleanup'")&&subscriptionState.includes("ja.access_lane='free'"),'Dormant cleanup blocking must remain scoped to the Free Jellyfin lane');
assert(inactivity.includes('observation_started_at')&&inactivity.includes('observationStartedAt'),'Inactivity audit evidence must record the effective observation start');

// Browser checkbox semantics must not be confused with backend fail-safe defaults.
assert(planLifecycleSource.includes('name="_lifecycleCheckboxes" value="1"')&&planLifecycleSource.includes('lifecycleFormInput(req.body)'),'Free-plan lifecycle form must explicitly mark browser checkbox submissions');
assert(globalLifecycleSource.includes('name="_lifecycleCheckboxes" value="1"')&&globalLifecycleSource.includes('lifecycleFormInput(req.body)'),'Global lifecycle form must explicitly mark browser checkbox submissions');
const planUnchecked=planLifecyclePage.lifecycleFormInput({_lifecycleCheckboxes:'1',enabled:'on',noPlaybackDays:'7'});
assert.strictEqual(planUnchecked.enabled,'on');
assert.strictEqual(planUnchecked.dryRun,false,'Unticking plan Dry run only must persist explicit false instead of falling back to safe true');
const planChecked=planLifecyclePage.lifecycleFormInput({_lifecycleCheckboxes:'1',enabled:'on',dryRun:'on',noPlaybackDays:'7'});
assert.strictEqual(planChecked.dryRun,'on','Checked plan Dry run only must remain true-like for policy normalization');
const planUnmarked=planLifecyclePage.lifecycleFormInput({enabled:'on',noPlaybackDays:'7'});
assert.strictEqual(Object.prototype.hasOwnProperty.call(planUnmarked,'dryRun'),false,'Unmarked/internal plan input must not synthesize enforcement');
assert.strictEqual(planPolicyRuntime.normalize(planUnmarked).dryRun,true,'Unmarked/internal plan input must retain the backend safe dry-run default');
const globalUnchecked=globalLifecyclePage.lifecycleFormInput({_lifecycleCheckboxes:'1',freeNoPlaybackDays:'7'});
assert.strictEqual(globalUnchecked.enabled,false,'Unticking global lifecycle automation must persist explicit false');
assert.strictEqual(globalUnchecked.dryRun,false,'Unticking global dry run must persist explicit false');
const globalChecked=globalLifecyclePage.lifecycleFormInput({_lifecycleCheckboxes:'1',enabled:'on',dryRun:'on',freeNoPlaybackDays:'7'});
assert.strictEqual(globalChecked.enabled,'on');
assert.strictEqual(globalChecked.dryRun,'on');

// A recently imported mapping may already carry trustworthy historical Jellyfin
// activity. That history should satisfy the observation window, while a genuinely
// new mapping with no prior evidence must retain the full grace period.
const now=Date.UTC(2026,7,27,9,0,0),day=86400000;
const usagePolicy={enabled:true,dryRun:true,noPlaybackDays:7,playbackWindowDays:7,minimumPlaybackMinutes:null,minimumObservationHours:24};
const importedAssessment=inactivityRuntime.assessUsage({account_created_at:new Date(now-5*day),starts_at:new Date(now-5*day),last_activity_at:new Date(now-10*day),last_playback_at:null,playback_seconds:0},usagePolicy,now);
assert.strictEqual(importedAssessment.noPlaybackEligible,true,'Historical Jellyfin activity older than the threshold must make a recently imported Free mapping eligible');
assert.strictEqual(importedAssessment.observationStartedAt.getTime(),now-10*day,'Historical activity must extend the observation window back before local import');
const newAssessment=inactivityRuntime.assessUsage({account_created_at:new Date(now-5*day),starts_at:new Date(now-5*day),last_activity_at:null,last_playback_at:null,playback_seconds:0},usagePolicy,now);
assert.strictEqual(newAssessment.noPlaybackEligible,false,'A genuinely new Free mapping with no historical activity must retain the observation grace period');
const recentPlaybackAssessment=inactivityRuntime.assessUsage({account_created_at:new Date(now-5*day),starts_at:new Date(now-5*day),last_activity_at:new Date(now-10*day),last_playback_at:new Date(now-2*day),playback_seconds:60},usagePolicy,now);
assert.strictEqual(recentPlaybackAssessment.noPlaybackEligible,false,'Recent Free-server playback must prevent inactivity even when older account history exists');
const strandedHeldFreeAccount={inactivity_policy:{},account_created_at:new Date(now-10*day),starts_at:new Date(now-10*day),last_activity_at:new Date(now-10*day),last_playback_at:null,playback_seconds:0,already_held:true,automation_protected:false,currently_playing:false};
const strandedPolicy=planPolicyRuntime.effectiveForFreePlan(strandedHeldFreeAccount.inactivity_policy,{enabled:true,dryRun:false,freeNoPlaybackDays:7});
const strandedAssessment=inactivityRuntime.assessUsage(strandedHeldFreeAccount,strandedPolicy,now);
const strandedEligible=strandedPolicy.enabled&&!strandedHeldFreeAccount.automation_protected&&!strandedHeldFreeAccount.currently_playing&&(strandedAssessment.noPlaybackEligible||strandedAssessment.usageEligible);
assert.strictEqual(strandedEligible,true,'An existing inactivity hold on an enabled Free account must retry disable/reconcile instead of being skipped forever');
assert(inactivity.includes('repairExistingHold:Boolean(row.already_held&&eligible)'),'Inactivity candidates must flag held-but-enabled Free accounts for repair visibility');

// Portal identity is never an inactivity target; automation touches Jellyfin access/user only.
assert(inactivity.includes("HOLD_TYPE='inactivity_policy'")&&inactivity.includes("CLEANUP_HOLD_TYPE='jellyfin_cleanup'"),'Lifecycle actions must use explicit Jellyfin holds');
assert(inactivity.includes('/Users/${encodeURIComponent(row.jellyfin_user_id)}')&&inactivity.includes("method:'DELETE'"),'Dormant cleanup must delete the Jellyfin user remotely');
assert(inactivity.includes('DELETE FROM jellyfin_accounts WHERE id=$1'),'Dormant cleanup must remove only the local Jellyfin account mapping');
assert(!/DELETE\s+FROM\s+customers/i.test(inactivity),'Inactivity automation must never delete CAPTAiNFiN customers');
assert(!/UPDATE\s+app_users\s+SET\s+active\s*=\s*FALSE/i.test(inactivity),'Inactivity automation must never deactivate portal logins');
assert(cleanupReturn.includes('includeBlocked:true'),'Portal return must be able to see through the cleanup hold');
assert(cleanupReturn.includes('hold_type=$2')&&cleanupReturn.includes("CLEANUP_HOLD_TYPE='jellyfin_cleanup'"),'Portal return must release only cleanup holds');
assert(provisioning.includes('releaseObsoleteForCustomer(customerId)'),'Every Jellyfin reconcile must discard obsolete free-plan inactivity holds');
assert(lifecycle.includes('await inactivityHolds.releaseObsoleteForCustomer(input.customerId)'),'Paid activation must release an obsolete free-plan hold immediately after commit');

// Server-scoped user import owns execution even though Customers exposes the entry point.
assert(serverForm.includes('Users / Import')&&serverForm.includes('/users'),'Each Jellyfin server must expose Users / Import in its local tabs');
assert(serverForm.includes('Sellable stream capacity'),'Jellyfin server configuration must expose the shared storefront stream-capacity budget');
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
assert(composition.includes('createAdminServerUsersRouter()')&&composition.includes('createAdminJellyfinPlanEditorRouter()')&&composition.includes('createAdminPlanInventoryRouter()'),'Plan lifecycle (now part of the unified Jellyfin plan editor)/inventory and server import routes must be mounted');

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