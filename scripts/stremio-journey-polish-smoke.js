'use strict';
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const customer=read('src/platform/customer-stremio.js');
const dashboard=read('views/customer/dashboard.ejs');
const checkout=read('public/js/customer-checkout.js');
const access=read('views/customer/jellyfin.ejs');
const accessJs=read('public/js/customer-jellyfin.js');

assert(customer.includes("r.get('/account/stremio',(req,res)=>res.redirect(302,'/account/access#stremio-access'))"),'legacy Stremio URL must redirect to My Access');
assert(customer.includes('installationLinks.current(req,customerId)'),'My Access must recover the authoritative current installation credential');
assert(customer.includes("res.setHeader('Cache-Control','no-store, private, max-age=0')"),'installation state endpoint must remain no-store');

assert(dashboard.includes('class="multiAccessSummary"'),'Home must keep the active access summary');
assert(dashboard.includes('class="accessSummaryCard"'),'Home must keep active plan cards');
assert(dashboard.includes('href="/account/access"'),'Home must link active access to My Access');
assert(!dashboard.includes('id="stremio-access"'),'Home must not server-render the Stremio setup panel');
assert(!dashboard.includes('action="/account/stremio/install"'),'Home must not own Stremio installation actions');
assert(!dashboard.includes('action="/account/stremio/revoke"'),'Home must not own Stremio revoke actions');
assert(!dashboard.includes('action="/account/stremio/reset-household"'),'Home must not own Stremio household actions');
assert(!dashboard.includes('Installation manifest'),'Home must not expose Stremio setup details');
assert(!checkout.includes("querySelector('#stremio-access')"),'Home must not rely on JavaScript to remove server-rendered Stremio setup');

assert(access.includes('id="stremio-access"')&&access.includes('data-stremio-access'),'My Access must contain the Stremio setup mount');
for(const needle of ['/account/stremio/installation.json','Household access','Get started with Stremio','Installation manifest','/account/stremio/install','/account/stremio/reset-household','/account/stremio/revoke'])assert(accessJs.includes(needle),`My Access Stremio UI missing ${needle}`);
assert(accessJs.includes("cache:'no-store'"),'My Access must fetch fresh installation-link state');
assert(accessJs.includes("name=\"returnTo\" value=\"access\""),'My Access Stremio mutations must return to My Access');

console.log('stremio journey polish smoke: ok');
