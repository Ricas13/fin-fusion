'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const nav=read('src/platform/admin-nav.js');
const application=read('src/application.js');
const createPlan=read('src/platform/admin-plan-create-v2.js');
const planPolicy=read('src/entitlements/plan-lifecycle-policy.js');
const inactivity=read('src/automation/customer-inactivity.js');
const cleanupReturn=read('src/entitlements/jellyfin-cleanup-return.js');
const provisioning=read('src/jellyfin/provisioning.js');
const lifecycle=read('src/payments/lifecycle.js');
const storefront=read('src/platform/storefront.js');
const serverUsers=read('src/platform/admin-server-users.js');
const serverForm=read('views/admin/server-form.ejs');
const serverLibraries=read('src/platform/admin-server-library-dashboard.js');
const plansList=read('src/platform/admin-plans-list.js');

// People now contains customer identity and playback only. Affiliate operations
// belong to Commerce; the retired reseller product must not return to navigation.
assert(!nav.includes("['jellyfin-import','Jellyfin Import'"),'Jellyfin Import must not return to the People sidebar');
assert(!nav.includes("['invitations','Invitations'"),'Invitations must not return to the People sidebar');
assert(nav.includes("['users','Customers'")&&nav.includes("['activity','Playback & Activity'"),'People must stay customer/activity focused');
assert(!nav.includes("['resellers','Resellers'"),'Retired reseller navigation must not return');
assert(nav.includes("['referrals','Affiliates','/admin/referrals']"),'Affiliate administration must live in Commerce');

// New customer plans are inventory-controlled and Jellyfin plans expose the real policy surface.
for(const token of ['capacityLimit','streams','allowDownloads','allowVideoTranscoding','allowAudioTranscoding','allowRemuxing','allowLiveTv','allowLiveTvManagement','allowRemoteAccess','libraryAccessMode','libraryNames'])assert(createPlan.includes(token),`New plan is missing ${token}`);
assert(createPlan.includes('allow_4k'),'New Jellyfin plans must persist the existing 4K catalogue flag');
assert(createPlan.includes('Subtitles:')&&createPlan.includes('does not expose a separate per-user subtitle permission'),'Plan UI must explain subtitle limitations instead of presenting a fake policy toggle');
assert(createPlan.includes('inactivityEnabled')&&createPlan.includes('minimumPlaybackMinutes')&&createPlan.includes('noPlaybackDays'),'Free plan creation must include configurable Jellyfin usage rules');
assert(planPolicy.includes("billing_interval||'')==='trial'"),'Plan usage disabling must explicitly exclude trial plans');

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

// Server-scoped user import replaces the global utility workflow.
assert(serverForm.includes('Users / Import')&&serverForm.includes('/users'),'Each Jellyfin server must expose Users / Import in its local tabs');
assert(serverUsers.includes("'/admin/servers/:serverId/users'")&&serverUsers.includes('importer.discover({serverId:s.id})'),'Import must be scoped to exactly one Jellyfin server');
assert(serverUsers.includes("'/admin/jellyfin-import'")&&serverUsers.includes("res.redirect(302,'/admin/servers"),'Legacy global import GET must guide the operator to a server');
assert(serverLibraries.includes("serverTabs(data.server.id,'libraries')"),'Libraries reached from a server must retain server tab context');

// Storefront remains plan-first and sold-out products stay visible.
for(const removed of ['Everything you need to watch your way','Your account follows you from screen to screen','From account to watching in minutes'])assert(!storefront.includes(removed),`Removed storefront section returned: ${removed}`);
assert(storefront.includes('Stremio add-ons & plans.')&&storefront.includes('Managed Jellyfin user plans.'),'Storefront must retain explicit service sections');
assert(storefront.includes('0 spots available · Sold out')&&storefront.includes("sold?'soldOut':''"),'Sold-out product cards must remain visible and visually disabled');
assert(plansList.includes('capacityMeter')&&plansList.includes('Manage inventory'),'Unified Plans must expose customer inventory state and its management entry point');

// Current workflow routes own customer-plan and server actions; reseller billing
// middleware/portal routes are intentionally absent from the assembled app.
assert(application.includes('createAdminPlanCreateV2Router()'),'Full-policy plan creation must be mounted');
assert(!application.includes('createAdminCatalogShellRouter'),'Legacy catalogue create routes must not be mounted alongside the V2 plan-create owner');
assert(application.includes('createAdminCustomerCreateRouter()'),'The non-plan Add Customer route must remain available after removing the legacy catalogue router');
assert(!application.includes('createResellerCapacityGateRouter()'),'Retired reseller capacity middleware must not be mounted');
assert(!application.includes('createResellerMonthlyPortalRouter()'),'Retired reseller billing portal must not be mounted');
assert(application.includes('createLegacyJellyfinImportRedirectRouter()')&&!application.includes('createAdminJellyfinImportRouter'),'Only the server-guidance redirect may own the legacy Jellyfin Import URL');
assert(application.includes('createAdminServerUsersRouter()')&&application.includes('createAdminPlanLifecycleRouter()')&&application.includes('createAdminPlanInventoryRouter()'),'Plan lifecycle/inventory and server import routes must be mounted');

console.log('plan-driven access lifecycle smoke: ok');