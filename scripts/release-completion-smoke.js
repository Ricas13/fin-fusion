'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

function read(file){return fs.readFileSync(path.join(__dirname,'..',file),'utf8');}
function has(source,fragment,message){assert(source.includes(fragment),message||`Expected ${fragment}`);}
function lacks(source,fragment,message){assert(!source.includes(fragment),message||`Did not expect ${fragment}`);}

const storefront=read('src/platform/storefront.js');
has(storefront,'function publicResellerTiers','storefront must explicitly filter reseller tiers for public sale');
has(storefront,'!tier.inventory.soldOut','closed reseller tiers must be excluded from the public catalogue');
has(storefront,'Number(tier.inventory.remaining||0)>0','reseller tier must have capacity before it is advertised');
has(storefront,"openResellerTiers.length?'<a href=\"#resellers\">Resellers</a>':''",'Resellers navigation must disappear when no tier is open');
has(storefront,'resellerSection(openResellerTiers,supportEmail)','only open reseller tiers may reach the public section');

const transfer=read('src/platform/configuration-transfer.js');
lacks(transfer,'document.configuration.resellerTiers=[]','configuration transfer must not discard live reseller tiers');
lacks(transfer,'resellerTiersCreate:0','configuration preview must report real reseller tier creates');
lacks(transfer,'resellerTiersUpdate:0','configuration preview must report real reseller tier updates');
has(transfer,'document.configuration.resellerTiers=await liveResellerCatalogue()','export must include the live monthly reseller catalogue');
has(transfer,'delete plan.reseller_credit_cost','retired reseller credit fields must still be stripped');
has(transfer,'delete plan.reseller_trial_credit_cost','retired reseller trial-credit fields must still be stripped');
lacks(transfer,'delete document.configuration.settings.reseller_defaults_v2','live monthly reseller defaults must remain portable');

const customerDashboard=read('views/customer/dashboard.ejs');
has(customerDashboard,'href="/help"><span>Help &amp; Support</span>','customer portal must expose Help & Support');
has(customerDashboard,'Your access entitlement is active','welcome pending state must work for paid and free access');
lacks(customerDashboard,'Your Free Access entitlement is active, but Jellyfin provisioning has not completed yet.','welcome copy must not incorrectly label paid users as Free Access');

const adminPassword=read('src/platform/admin-customer-jellyfin-password.js');
has(adminPassword,"router.get('/admin/customer-jellyfin-password'",'admin Jellyfin password support page must be mounted');
has(adminPassword,'provisioning.setJellyfinPassword(req.params.customerId,req.params.accountId,password)','admin support must use canonical Jellyfin password setter');
has(adminPassword,"'admin.customer.jellyfin_password.change'",'admin-assisted password changes must be audited');
lacks(adminPassword,'JSON.stringify({password','password must never be placed in audit metadata');
const adminRouter=read('src/platform/router.js');
has(adminRouter,'createAdminCustomerJellyfinPasswordRouter','admin password support router must be part of the live platform router');
const adminNav=read('src/platform/admin-nav.js');
has(adminNav,"['customer-jellyfin-password','Jellyfin Passwords','/admin/customer-jellyfin-password']",'admin password support must be discoverable under People');

const paypalReturn=read('src/platform/customer-payment-return.js');
has(paypalReturn,"/account?welcome=1&message=",'PayPal completion must enter the access welcome flow');
const checkout=read('src/platform/flexible-checkout.js');
has(checkout,"/account?welcome=1&message=Payment%20received.",'Stripe completion must enter the access welcome flow');
const activation=read('src/platform/account-activation-router.js');
has(activation,"'/account?welcome=1'",'customer activation must carry the user into the access welcome flow');

const servers=read('src/platform/admin-servers.js');
has(servers,'Enable private integrations and add this Jellyfin hostname or network CIDR','private-address connection failures must explain how to resolve outbound trust');
has(servers,'Jellyfin hostname could not be resolved','DNS failures must be actionable');
has(servers,'connection was refused','connection-refused failures must be actionable');

const firstRun=read('views/auth/first-run-claim.ejs');
has(firstRun,'docker compose exec app npm run setup:claim','first-run setup must show a direct setup-code retrieval command');
has(firstRun,'You do not need to search application logs.','first-run setup must not require log archaeology');

console.log('release completion smoke: ok');
