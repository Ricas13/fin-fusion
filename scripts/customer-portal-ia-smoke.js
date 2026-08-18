'use strict';
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

const dashboard=read('views/customer/dashboard.ejs');
const nav=read('views/customer/_nav.ejs');
const router=read('src/platform/router.js');
const paymentReturn=read('src/platform/customer-payment-return.js');
const checkout=read('src/platform/flexible-checkout.js');
const stremio=read('views/customer/stremio-dashboard.ejs');
const history=read('src/platform/customer-history.js');

for(const label of ['Overview','Streaming','Plans &amp; billing','Activity','Notifications','Security','Benefits','Help &amp; support'])assert(nav.includes(label),`customer navigation missing ${label}`);
assert(dashboard.includes("include('_nav',{active:'overview'})"),'dashboard must use shared customer navigation');
assert(dashboard.includes('Upgrade: changes immediately')&&dashboard.includes('scheduled for your next renewal'),'dashboard must disclose Stripe plan-change timing before checkout');
assert(dashboard.includes('Stop PayPal renewal first'),'dashboard must disclose active recurring PayPal plan-change constraint');
assert(!/provisioning source|server placement|reconciliation/i.test(dashboard),'dashboard exposes operator-only jargon');
assert(stremio.includes("include('_nav',{active:'overview'})"),'Stremio-only dashboard must use shared navigation');
assert(history.includes("customerNav.nav('plans')"),'billing history must use shared navigation');
assert(/\/account\/trial\/start[\s\S]*welcome=1/.test(router),'trial completion must enter welcome flow');
assert(/\/account\/claim-free\/:planCode[\s\S]*welcome=1/.test(router),'Free Access completion must enter welcome flow');
assert(paymentReturn.includes('/account?welcome=1'),'PayPal completion must enter welcome flow');
assert(checkout.includes('/account?welcome=1&message=Payment%20received.'),'Stripe completion must enter welcome flow');
console.log('customer portal IA smoke: ok');
