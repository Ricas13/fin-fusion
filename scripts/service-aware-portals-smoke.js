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
const bulkOperations=read('src/platform/bulk-operations.js');

assert(/assertSellableCode/.test(readiness)&&/PLAN_/.test(readiness),'product readiness must expose a fail-closed sale assertion');

assert(/delivery==='stremio'/.test(customerDashboard)&&/stremio-dashboard/.test(customerDashboard),'Stremio-only customers must use a service-specific dashboard');
assert(/sellablePlans/.test(customerDashboard)&&/productReadiness\.evaluate/.test(customerDashboard),'customer acquisition catalogue must hide undeliverable products');
assert(/Create your private installation link/.test(stremioDashboard)&&/does not contain your portal password or Jellyfin administrator credentials/.test(stremioDashboard),'Stremio-only dashboard must explain the private installation delivery model safely');
assert(/admin\/plans\/:id\/delivery/.test(planDelivery)&&/snapshots were preserved/.test(planDelivery),'plan delivery editor must preserve existing subscription snapshots');
assert(/admin\.plan\.delivery\.update/.test(planDelivery)&&/mutationLimit/.test(planDelivery),'plan delivery mutation must be audited and rate limited');
assert(/createAdminPlanDeliveryRouter/.test(router),'plan delivery router must be mounted');
assert(/\/delivery/.test(plansList)&&/>Delivery</.test(plansList),'Plans list must link to normal delivery management');
assert(/registerHandler\('retry_failed'.*provisioning\.reconcileCustomer\(item\.customer_id\)/s.test(bulkOperations)&&/retriedThrough:'service-aware-reconciliation'/.test(bulkOperations),'Retry failed setup must use service-aware reconciliation for Jellyfin, Stremio and bundle customers');

console.log('service-aware portals smoke: ok');
