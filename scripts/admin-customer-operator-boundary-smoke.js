'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const route=read('src/platform/admin-customer-operator.js');
const service=read('src/access/admin-customer-operator-service.js');

assert(route.includes("require('../access/customer-access-state')"),
  'operator context must consume canonical cross-service access state');
assert(route.includes("require('../access/admin-customer-operator-service')"),
  'operator mutations must delegate to the access-domain service');
for(const forbidden of [
  "require('../jellyfin/resilient-provisioning')",
  "require('../jellyfin/manual-assignment')",
  "require('../jellyfin/admin-force-move')",
  'adminControl.remove(',
  'adminControl.clear(',
  'provisioning.reconcileCustomer('
]){
  assert(!route.includes(forbidden),`platform customer operator must not own mutation orchestration: ${forbidden}`);
}
assert(service.includes("require('./customer-access-state')"),
  'operator service must resolve the exact current Jellyfin entitlement through canonical access state');
assert(service.includes('access.primary?.entitlement')&&service.includes('access.free?.entitlement'),
  'operator service must preserve both primary and Free Jellyfin lanes');
assert(service.includes('manualAssignment.assign(')
  && service.includes('forceMove.move(')
  && service.includes('adminControl.remove(')
  && service.includes('adminControl.clear(')
  && service.includes('provisioning.reconcileCustomer('),
  'access-domain operator service must own customer access mutation orchestration');

console.log('admin customer operator boundary smoke: ok');
