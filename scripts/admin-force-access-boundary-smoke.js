'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const root=path.join(__dirname,'..');
const router=fs.readFileSync(path.join(root,'src/platform/admin-customer-force-access.js'),'utf8');
const service=fs.readFileSync(path.join(root,'src/access/admin-force-access-service.js'),'utf8');

assert(router.includes("require('../access/admin-force-access-service')"),
  'force-access router must delegate business orchestration to the access domain service');
for(const forbidden of [
  "require('../db')",
  "require('../entitlements/permanent-access')",
  "require('../jellyfin/manual-assignment')",
  "require('../jellyfin/durable-account-creation')",
  "require('../jellyfin/admin-force-move')",
  'INSERT INTO audit_log',
  'jellyfin_account_creation_intents'
]){
  assert(!router.includes(forbidden),`platform router must not own force-access business detail: ${forbidden}`);
}
for(const required of [
  'async function forceAccess',
  'async function returnToPlanRules',
  'async function recoverCreatedAccount',
  'permanentAccess.enable',
  'manualAssignment.assign',
  'adminControl.forceServer',
  'provisioning.reconcileCustomer'
]){
  assert(service.includes(required),`access domain service must own ${required}`);
}
assert(router.includes('module.exports={createAdminCustomerForceAccessRouter,forceAccess,returnToPlanRules,recoverCreatedAccount'),
  'router compatibility exports must remain available while delegating to the domain service');

console.log('admin force-access platform boundary smoke: ok');
