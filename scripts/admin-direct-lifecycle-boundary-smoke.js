'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const router=fs.readFileSync(path.join(root,'src/platform/admin-customer-direct-lifecycle.js'),'utf8');
const service=fs.readFileSync(path.join(root,'src/access/admin-customer-lifecycle-service.js'),'utf8');

assert(router.includes("require('../access/admin-customer-lifecycle-service')"),
  'direct lifecycle router must delegate mutation orchestration to a domain service');
for(const forbidden of [
  "require('../payments/customer-plan-change')",
  "require('../payments/plan-pricing')",
  "require('../jellyfin/resilient-provisioning')",
  "require('../jellyfin/admin-force-move')",
  'UPDATE subscriptions SET plan_id=',
  'planChange.requestChange({'
]){
  assert(!router.includes(forbidden),`platform lifecycle router must not own mutation detail: ${forbidden}`);
}
for(const required of [
  'async function applyLocalPlanContract',
  'async function changePlan',
  'planChange.requestChange({',
  'provisioning.reconcileCustomer(customerId)',
  'return forceMove.move(customerId,serverId'
]){
  assert(service.includes(required),`domain lifecycle service must own ${required}`);
}
assert(router.includes('lifecycleService.changePlan({')
  && router.includes('lifecycleService.moveServer('),
  'HTTP handlers must validate input then call the domain lifecycle service');

console.log('admin direct-lifecycle platform boundary smoke: ok');
