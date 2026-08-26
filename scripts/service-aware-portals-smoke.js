'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const readiness=read('src/platform/product-readiness.js');
const customerDashboard=read('src/platform/customer-dashboard.js');
const stremioDashboard=read('views/customer/stremio-dashboard.ejs');
const planDelivery=read('src/platform/admin-plan-delivery.js');
const router=read('src/platform/router.js');
const plansList=read('src/platform/admin-plans-list.js');
const planWorkflow=read('public/js/admin-plan-workflow.js');
const bulkOperations=read('src/platform/bulk-operations.js');
const lifecycle=read('src/payments/lifecycle.js');
const subscriptionState=read('src/entitlements/subscription-state.js');
const stremioEntitlements=read('src/stremio/entitlements.js');
const customerStremio=read('src/platform/customer-stremio.js');
const checkout=read('src/platform/flexible-checkout.js');
const migration=read('db/migrations/044_multi_service_subscriptions.sql');

assert(/assertSellableCode/.test(readiness)&&/PLAN_/.test(readiness),'product readiness must expose a fail-closed sale assertion');

assert(/delivery==='stremio'/.test(customerDashboard)&&/stremio-dashboard/.test(customerDashboard),'Stremio-only customers must use a service-specific dashboard');
assert(/sellablePlans/.test(customerDashboard)&&/productReadiness\.evaluate/.test(customerDashboard),'customer acquisition catalogue must hide undeliverable products');
assert(/Create your private installation link/.test(stremioDashboard)&&/does not contain your portal password or Jellyfin administrator credentials/.test(stremioDashboard),'Stremio-only dashboard must explain the private installation delivery model safely');
assert(/admin\/plans\/:id\/delivery/.test(planDelivery)&&/snapshots were preserved/.test(planDelivery),'plan delivery editor must preserve existing subscription snapshots');
assert(/admin\.plan\.delivery\.update/.test(planDelivery)&&/mutationLimit/.test(planDelivery),'plan delivery mutation must be audited and rate limited');
assert(/createAdminPlanDeliveryRouter/.test(router),'plan delivery router must be mounted');
assert(/\/delivery/.test(planWorkflow)&&/Delivery/.test(planWorkflow)&&/\/delivery\$/.test(planWorkflow)&&!/>Delivery<\/a>/.test(plansList),'Plan workflow must expose delivery management after opening a plan without restoring arbitrary list shortcuts');
assert(/registerHandler\('retry_failed'.*provisioning\.reconcileCustomer\(item\.customer_id\)/s.test(bulkOperations)&&/retriedThrough:'service-aware-reconciliation'/.test(bulkOperations),'Retry failed setup must use service-aware reconciliation for Jellyfin, Stremio and bundle customers');

assert(/serviceScope\.overlaps/.test(lifecycle)&&/!serviceScope\.isFreeTier/.test(lifecycle),'trial eligibility must be scoped by overlapping service and ignore permanent Free Server fallback');
assert(/effectiveStremioSubscription/.test(subscriptionState),'subscription state must expose a dedicated Stremio primary entitlement');
assert(/effectiveStremioSubscription\(customerId\)/.test(stremioEntitlements),'Stremio entitlement resolution must not depend on the Jellyfin primary entitlement');
assert(/stremio\.entitledSubscription/.test(customerStremio),'customer Stremio portal must use the Stremio-specific entitlement lane');
assert(/overlappingRecurring/.test(checkout)&&/serviceScope\.overlaps/.test(checkout),'recurring checkout must only treat overlapping services as plan changes');
assert(/effective_stremio_entitlements/.test(migration),'database must expose an independent Stremio primary entitlement view');
assert(/COALESCE\(p\.is_free_tier,FALSE\) ASC/.test(migration),'paid or trial Jellyfin access must overlay the permanent Free Server fallback');
assert(/subscription_access_blocked/.test(migration)&&/payment_delinquency/.test(migration),'provider delinquency holds must be scoped to the affected recurring subscription');

console.log('service-aware portals smoke: ok');
