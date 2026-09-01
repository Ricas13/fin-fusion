'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const readiness=read('src/platform/product-readiness.js');
const customerDashboard=read('src/platform/customer-dashboard.js');
const customerDashboardView=read('views/customer/dashboard.ejs');
const planDelivery=read('src/platform/admin-plan-delivery.js');
const router=read('src/platform/router.js');
const plansList=read('src/platform/admin-plans-list.js');
const planWorkflow=read('public/js/admin-plan-workflow.js');
const bulkOperations=read('src/platform/bulk-operations.js');
const lifecycle=read('src/payments/lifecycle.js');
const subscriptionState=read('src/entitlements/subscription-state.js');
const stremioEntitlements=read('src/stremio/entitlements.js');
const checkout=read('src/platform/flexible-checkout.js');
const planChange=read('src/payments/customer-plan-change.js');
const migration=read('db/migrations/044_multi_service_subscriptions.sql');
const embyMigration=read('db/migrations/20260901170000_emby_share_service_lane.sql');
const serviceCatalog=read('src/catalog/service-catalog.js');
const publicShell=read('src/platform/public-shell.js');
const storefront=read('src/platform/storefront.js');
const embyEditor=read('src/platform/admin-emby-plan-editor.js');
const routeComposition=read('src/platform/admin-route-composition.js');
const mediaReconciliation=read('src/jellyfin/media-service-reconciliation.js');
const serviceScope=require('../src/entitlements/service-scope');

assert(/assertSellableCode/.test(readiness)&&/PLAN_/.test(readiness),'product readiness must expose a fail-closed sale assertion');

assert(/stremioEntitlements\.entitledSubscription\(customerId\)/.test(customerDashboard)&&/res\.render\('customer\/dashboard',[\s\S]*stremioPlan/.test(customerDashboard),'Stremio-only and mixed-service customers must use the unified multi-access Home');
assert(/sellablePlans/.test(customerDashboard)&&/productReadiness\.evaluatePlan/.test(customerDashboard),'customer acquisition catalogue must hide undeliverable products with plan-specific readiness');
assert(/Create your private installation link/.test(customerDashboardView)&&/Keep this link private/.test(customerDashboardView)&&/Installation manifest/.test(customerDashboardView),'Account Home Stremio surface must explain the private installation delivery model safely');
assert(!fs.existsSync(path.join(root,'views/customer/stremio-dashboard.ejs')),'retired standalone Stremio dashboard must stay removed');
assert(/admin\/plans\/:id\/delivery/.test(planDelivery)&&/snapshots were preserved/.test(planDelivery),'plan delivery editor must preserve existing subscription snapshots');
assert(/admin\.plan\.delivery\.update/.test(planDelivery)&&/mutationLimit/.test(planDelivery),'plan delivery mutation must be audited and rate limited');
assert(/createAdminPlanDeliveryRouter/.test(router),'plan delivery router must be mounted');
assert(/\/delivery/.test(planWorkflow)&&/Delivery/.test(planWorkflow)&&/\/delivery\$/.test(planWorkflow)&&!/>Delivery<\/a>/.test(plansList),'Plan workflow must expose delivery management after opening a plan without restoring arbitrary list shortcuts');
assert(/registerHandler\('retry_failed'.*provisioning\.reconcileCustomer\(item\.customer_id\)/s.test(bulkOperations)&&/retriedThrough:'service-aware-reconciliation'/.test(bulkOperations),'Retry failed setup must use service-aware reconciliation for Jellyfin, Stremio and bundle customers');

assert(/serviceScope\.overlaps/.test(lifecycle)&&/!serviceScope\.isFreeTier/.test(lifecycle),'trial eligibility must be scoped by overlapping service and ignore permanent Free Server fallback');
assert(/effectiveStremioSubscription/.test(subscriptionState),'subscription state must expose a dedicated Stremio primary entitlement');
assert(/effectiveStremioSubscription\(customerId\)/.test(stremioEntitlements),'Stremio entitlement resolution must not depend on the Jellyfin primary entitlement');
assert(/stremioEntitlements\.entitledSubscription\(customerId\)/.test(customerDashboard),'unified Account Home must use the Stremio-specific entitlement lane');
assert(/overlappingRecurring/.test(checkout)&&/serviceScope\.overlaps/.test(checkout),'recurring checkout must only treat overlapping services as plan changes');
assert(/effective_stremio_entitlements/.test(migration),'database must expose an independent Stremio primary entitlement view');
assert(/COALESCE\(p\.is_free_tier,FALSE\) ASC/.test(migration),'paid or trial Jellyfin access must overlay the permanent Free Server fallback');
assert(/subscription_access_blocked/.test(migration)&&/payment_delinquency/.test(migration),'provider delinquency holds must be scoped to the affected recurring subscription');

assert(serviceScope.overlaps({service_type:'emby'},{service_type:'emby'}),'Emby plans must overlap other Emby plans');
assert(!serviceScope.overlaps({service_type:'emby'},{service_type:'jellyfin'}),'Emby and Jellyfin must remain independent service lanes');
assert(!serviceScope.overlaps({service_type:'emby'},{service_type:'stremio'}),'Emby and Stremio must remain independent service lanes');
assert(!serviceScope.overlaps({service_type:'emby'},{service_type:'bundle'}),'historical Jellyfin + Stremio bundles must not overlap Emby');
assert(/emby:[\s\S]*mediaServerType: 'emby'/.test(serviceCatalog)&&/type === 'bundle' \? Object\.freeze\(\['jellyfin', 'stremio'\]\)/.test(serviceCatalog),'service catalogue must define Emby without changing historical bundle capability semantics');
assert(/\.filter\(section => section\.plans\.length > 0\)/.test(serviceCatalog),'public catalogue sections must disappear when their service has no plans');
assert(/nav\.emby&&\['emby','Emby Shares','\/#emby'\]/.test(publicShell),'public navigation must expose Emby Shares only through the plan-driven nav state');
assert(/productReadiness\.evaluatePlan/.test(storefront)&&/serviceCatalog\.storefrontSections/.test(storefront),'storefront must be both readiness-gated and catalogue-driven');
assert(/Emby Shares/.test(plansList)&&/Add Emby Share plan/.test(plansList)&&/groups\.emby/.test(plansList),'Commerce Plans must keep the Emby Shares admin section and add action even before the first plan exists');
assert(/INSERT INTO plans\([\s\S]*service_type[\s\S]*VALUES\([\s\S]*'emby'/.test(embyEditor)&&/COALESCE\(js\.media_server_type,'jellyfin'\)='emby'/.test(embyEditor)&&/\/admin\/plans\/emby/.test(embyEditor),'Emby plan editor must create an Emby product and restrict placement to Emby servers');
assert(routeComposition.indexOf('createAdminEmbyPlanEditorRouter')<routeComposition.indexOf('createAdminPlanCreateV2Router'),'Emby plan routes must be mounted before the shared Jellyfin/Stremio create workflow');
assert(/effectiveEmbySubscription/.test(subscriptionState)&&/effective_emby_entitlements/.test(subscriptionState),'subscription state must expose an independent Emby primary entitlement');
assert(/effectiveEmbySubscription\(customerId/.test(customerDashboard)&&/embyPlan/.test(customerDashboard)&&/hasEmby/.test(customerDashboard),'Emby-only customers must use the unified account dashboard instead of onboarding');
assert(/id="emby-access"/.test(customerDashboardView)&&/Open Emby/.test(customerDashboardView)&&/Emby Shares/.test(customerDashboardView)&&/\['jellyfin','stremio','emby','bundle'\]/.test(customerDashboardView),'customer Account Home must render Emby as Emby instead of falling back to Jellyfin');
assert(/planServers\.eligibleServersForPlan/.test(mediaReconciliation)&&/media_server_type/.test(mediaReconciliation)&&/password_setup_required=TRUE/.test(mediaReconciliation),'Emby provisioning must use media-type-scoped placement and surface bootstrap password setup');
assert(/effectiveEmbySubscription/.test(planChange),'recurring plan changes must resolve the Emby service lane');
assert(!/effective_customer_entitlements WHERE customer_id/.test(checkout),'checkout plan changes must not be gated by the Jellyfin-only effective entitlement view');
assert(/CHECK \(service_type IN \('jellyfin','stremio','emby','bundle'\)\)/.test(embyMigration)&&/effective_emby_entitlements/.test(embyMigration),'database migration must allow Emby plans and create the independent Emby entitlement view');
assert(/provisioning_runs_action_check/.test(embyMigration)&&/jellyfin_reconcile/.test(embyMigration)&&/jellyfin_disable/.test(embyMigration)&&/emby_reconcile/.test(embyMigration)&&/emby_disable/.test(embyMigration),'Emby migration must permit service-scoped media reconciliation audit actions without removing historical provisioning actions');
assert(/new_service='bundle'[\s\S]*IN \('jellyfin','stremio','bundle'\)/.test(embyMigration),'recurring-subscription constraint must keep historical bundles isolated from Emby');

console.log('service-aware portals smoke: ok');