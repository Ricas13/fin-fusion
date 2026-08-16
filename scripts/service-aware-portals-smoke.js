'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const readiness=read('src/platform/product-readiness.js');
const resellerSettings=read('src/resellers/settings.js');
const resellerBusiness=read('src/platform/reseller-business.js');
const customerDashboard=read('src/platform/customer-dashboard.js');
const stremioDashboard=read('views/customer/stremio-dashboard.ejs');
const planDelivery=read('src/platform/admin-plan-delivery.js');
const router=read('src/platform/router.js');
const plansList=read('src/platform/admin-plans-list.js');

assert(/assertSellableCode/.test(readiness)&&/PLAN_/.test(readiness),'product readiness must expose a fail-closed sale assertion');
assert(/commercial_readiness/.test(resellerSettings)&&/sellable/.test(resellerSettings),'reseller catalogue must filter by canonical readiness');
assert(/!owner\|\|productReadiness\.serviceType\(plan\)==='jellyfin'/.test(resellerSettings),'reseller owner plans must remain Jellyfin-only until owner Stremio install ownership exists');
assert(/saleReadinessGuard/.test(resellerBusiness)&&/assertSellableCode/.test(resellerBusiness),'reseller POST sales must be protected server-side');
assert(/customerPortalPolicy==='jellyfin_only'/.test(resellerBusiness),'Stremio reseller sales must reject Jellyfin-only portal policy');
assert(/createPortal!=='1'/.test(resellerBusiness),'optional portal mode must require a portal when creating Stremio customers');
assert(/SELECT user_id FROM customers/.test(resellerBusiness),'existing reseller customers must already own a portal identity before switching to Stremio');
assert(/delivery==='stremio'/.test(customerDashboard)&&/stremio-dashboard/.test(customerDashboard),'Stremio-only customers must use a service-specific dashboard');
assert(/sellablePlans/.test(customerDashboard)&&/productReadiness\.evaluate/.test(customerDashboard),'customer acquisition catalogue must hide undeliverable products');
assert(/Manage Stremio installation/.test(stremioDashboard)&&/You do not need a normal Jellyfin login/.test(stremioDashboard),'Stremio-only dashboard must explain the delivery model');
assert(/admin\/plans\/:id\/delivery/.test(planDelivery)&&/snapshots were preserved/.test(planDelivery),'plan delivery editor must preserve existing subscription snapshots');
assert(/admin\.plan\.delivery\.update/.test(planDelivery)&&/mutationLimit/.test(planDelivery),'plan delivery mutation must be audited and rate limited');
assert(/createAdminPlanDeliveryRouter/.test(router),'plan delivery router must be mounted');
assert(/\/delivery/.test(plansList)&&/>Delivery</.test(plansList),'Plans list must link to normal delivery management');

console.log('service-aware portals smoke: ok');
