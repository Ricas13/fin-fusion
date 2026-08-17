'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const monthly=read('src/resellers/monthly.js');
const ux=read('src/platform/reseller-service-aware-portal-v2.js');
const business=read('src/platform/reseller-business.js');
const retirement=read('src/platform/reseller-legacy-route-retirement.js');

// Reseller runtime is intentionally Jellyfin managed-seat licensing. Stremio
// remains a customer-plan capability, not a downstream reseller-sale option.
assert(/reseller_managed=TRUE/.test(monthly),'reseller seat usage must count only managed Jellyfin users');
assert(/assertSeatAvailable/.test(monthly)&&/seat_limit/.test(monthly),'reseller domain must enforce the monthly managed-user allowance');
assert(/reconcileEstate/.test(monthly)&&/reseller_subscription/.test(monthly),'reseller subscription state must control the managed Jellyfin estate');
assert(!/createOrRenewCustomer/.test(monthly)&&!/salesAnalytics/.test(monthly)&&!/endCustomerService/.test(monthly),'active reseller domain must not export downstream customer sales operations');
assert(/createResellerServiceAwarePortalRouter/.test(business)&&/createResellerLegacyRouteRetirementRouter/.test(business),'managed-user portal and legacy retirement router must be mounted together');
assert(/Managed Jellyfin users/.test(ux)&&/\/reseller\/user\/create/.test(ux),'reseller UX must be centred on managed Jellyfin users');
assert(/managedUsers\.createManagedUser/.test(ux)&&/managedUsers\.deleteManagedUser/.test(ux),'reseller mutations must go through the managed-user domain');
assert(/tierPriceId/.test(ux)&&/\/reseller\/billing\/stripe/.test(ux)&&/\/reseller\/billing\/paypal/.test(ux),'reseller plan purchase UX must carry the selected multi-currency tier price');
assert(/How you charge or manage those people commercially stays outside CAPTAiNFiN/.test(ux),'reseller UX must keep downstream commercial management outside CAPTAiNFiN');
assert(/\/reseller\/sales/.test(ux)&&/\/reseller\/customer\/create/.test(ux),'common downstream reseller routes must remain explicitly retired by the managed-user portal');
assert(/\/reseller\/customer\/:id\/end-service/.test(retirement)&&/\/reseller\/customer\/:id\/credentials\/reset/.test(retirement),'remaining downstream reseller operations must remain explicitly retired by the compatibility router');
assert(!/reseller-service-aware\.js/.test(ux),'retired downstream-sale browser helper must not be loaded by the managed-seat portal');

console.log('reseller managed-seat UX smoke: ok');
