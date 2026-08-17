'use strict';

process.env.NODE_ENV='development';
process.env.SESSION_SECRET=process.env.SESSION_SECRET||'assembled-app-smoke-secret-0123456789abcdef';
delete process.env.DATABASE_URL;
const {createApplication}=require('../src/application');
function routeEntries(stack,out=[]){for(const layer of stack||[]){if(layer.route){const path=String(layer.route.path);for(const[method,enabled]of Object.entries(layer.route.methods||{}))if(enabled)out.push({method:method.toUpperCase(),path});}if(layer.handle?.stack)routeEntries(layer.handle.stack,out);}return out;}
function count(entries,method,path){return entries.filter(entry=>entry.method===method&&entry.path===path).length}
function requireExactly(entries,method,path,n=1){const actual=count(entries,method,path);if(actual!==n)throw new Error(`${method} ${path}: expected ${n} mounted route(s), found ${actual}`)}
function requireAtLeast(entries,method,path,n=1){const actual=count(entries,method,path);if(actual<n)throw new Error(`${method} ${path}: expected at least ${n}, found ${actual}`)}
const app=createApplication(),entries=routeEntries(app._router?.stack||[]);
for(const[method,path]of[
 ['GET','/'],['GET','/account/affiliate'],['POST','/account/affiliate/redeem'],
 ['POST','/account/checkout/stripe'],['POST','/account/checkout/paypal'],['GET','/account/paypal/return'],['POST','/account/stripe/portal'],['POST','/account/subscription/renewal'],['POST','/account/plan-change/cancel'],
 ['GET','/admin/referrals'],['POST','/admin/referrals/settings'],['GET','/admin/automation'],['GET','/admin/search'],['GET','/admin/events'],['GET','/admin/commerce'],['GET','/admin/notifications/preferences'],['POST','/admin/notifications/preferences'],
 ['GET','/admin/provisioning/drift'],['GET','/admin/configuration-health'],['GET','/admin/configuration'],['GET','/admin/configuration/export'],['POST','/admin/configuration/preview'],['POST','/admin/configuration/apply'],['GET','/account/history']
])requireExactly(entries,method,path);

// The reseller product is retired from the supported assembled application.
// Historical tables remain for upgrade/audit only; no live reseller GET/POST
// product owners may be required by this contract.
for(const path of ['/reseller','/reseller/security','/reseller/tier-change','/reseller/export','/reseller/ledger','/reseller/sales','/admin/reseller-management','/admin/reseller-tiers']){
 requireExactly(entries,'GET',path,0);
}
for(const path of ['/reseller/billing/tier'])requireExactly(entries,'POST',path,0);

for(const[method,path]of[['POST','/webhooks/stripe'],['POST','/webhooks/paypal'],['GET','/activate/:token'],['POST','/activate/:token'],['GET','/account'],['POST','/account/logout']])requireAtLeast(entries,method,path);
const duplicateCritical=[],criticalPrefixes=['/account/affiliate','/account/checkout','/account/paypal/return','/account/subscription','/account/plan-change','/admin/referrals','/admin/configuration','/admin/provisioning/drift','/admin/notifications/preferences'],grouped=new Map();
for(const entry of entries){const key=`${entry.method} ${entry.path}`;grouped.set(key,(grouped.get(key)||0)+1)}
for(const[key,n]of grouped)if(n>1&&criticalPrefixes.some(prefix=>key.includes(` ${prefix}`)))duplicateCritical.push(`${key} x${n}`);
if(duplicateCritical.length)throw new Error(`Critical duplicate routes detected: ${duplicateCritical.join(', ')}`);
console.log(`Assembled application route contract OK (${entries.length} mounted method/routes inspected; affiliate runtime present, reseller product absent).`);
process.exit(0);