'use strict';

const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message);};

const pending=read('src/security/pending-registration.js');
const primary=read('src/platform/admin-customer-primary-actions.js');
const guard=read('public/js/admin-customer-portal-guard.js');
const customer360=read('src/platform/customer-360.js');
const impersonation=read('src/platform/admin-impersonation.js');

assert(pending.includes('lockExistingCustomerForRegistration'),'verified registration must resolve an existing customer before creating a second customer row');
assert(pending.includes("lower(BTRIM(COALESCE(email,'')))=lower(BTRIM($1))")&&pending.includes('FOR UPDATE'),'existing-customer email resolution must be normalized and row-locked');
assert(pending.includes('if(matches.rowCount>1)'),'ambiguous same-email customer rows must never be guessed');
assert(pending.includes('if(customer?.user_id)'),'registration must not relink an already claimed customer');
assert(pending.includes('UPDATE customers SET user_id=$1')&&pending.includes('WHERE id=$4 AND user_id IS NULL'),'verified registration must atomically link the one unclaimed existing customer');
assert(pending.includes('linkedExistingCustomer:Boolean(existingCustomer.customer)'),'verified-registration audit metadata must record whether an existing customer was linked');

assert(customer360.includes('LEFT JOIN app_users u ON u.id=c.user_id')&&customer360.includes('u.id AS app_user_id'),'Customer 360 portal identity must come from the canonical customers.user_id relationship');
assert(impersonation.includes('LEFT JOIN app_users u ON u.id=c.user_id'),'admin impersonation must keep using the same direct customer/app-user relationship');

assert(primary.includes('data-customer-portal-primary="1"'),'Customer Actions must mark the canonical portal tile explicitly');
assert(primary.includes('data-native-submit="true" data-customer-portal-action="1"'),'portal impersonation must remain a native POST instead of an inline admin mutation');
assert(primary.includes('/js/admin-customer-portal-guard.js'),'Customer 360 must load the focused portal action guard');
assert(guard.includes("const grid=document.querySelector('[data-customer-primary-actions] .customerActionGrid')"),'portal guard must be scoped to Customer Actions only');
assert(guard.includes("grid.querySelector('[data-customer-portal-primary=\"1\"]')"),'portal guard must detect the canonical server-rendered portal tile');
assert(guard.includes('observer.observe(grid,{childList:true})'),'portal guard must restore a later-removed action without observing the whole document');
assert(!guard.includes('document.body')&&!guard.includes('subtree:true'),'portal guard must not reintroduce the whole-page MutationObserver freeze');

console.log('customer portal linkage smoke: ok');
