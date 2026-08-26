'use strict';

const fs=require('fs');
const assert=require('assert');
const capacity=require('../src/entitlements/plan-capacity');

const read=file=>fs.readFileSync(file,'utf8');
const create=read('src/platform/admin-plan-create-v2.js');
const inventory=read('src/platform/admin-plan-inventory.js');
const migration=read('db/migrations/000_database_baseline.sql');

assert(create.includes("capacityLimit=int(body.capacityLimit,0,1000000,'Available slots')"),'new-plan backend must accept zero available slots');
assert(create.includes("capacityLimit:input.capacityLimit??'0'"),'new plans must default to zero availability');
assert(create.includes('name="capacityLimit" required')&&create.includes('min="0" max="1000000"'),'new-plan browser control must allow zero slots');
assert(inventory.includes('name="capacityLimit" min="0" max="1000000"'),'Availability editor must allow zero slots');
assert(inventory.includes('n<0||n>1000000'),'Availability backend must accept zero and reject negative limits');
assert(/CONSTRAINT plans_capacity_limit_check CHECK \(\(\(capacity_limit IS NULL\) OR \(capacity_limit >= 0\)\)\)/.test(migration),'database constraint must admit explicit zero capacity');

(async()=>{
  const fakeDb=async()=>({rowCount:1,rows:[{id:'zero-plan',capacity_limit:0,used:0}]});
  const state=await capacity.usage('zero-plan',fakeDb);
  assert.strictEqual(state.limit,0,'zero must remain an explicit numeric capacity');
  assert.strictEqual(state.remaining,0,'zero-capacity plan must report zero remaining');
  assert.strictEqual(state.soldOut,true,'zero-capacity plan must be sold out before any acquisition');
  await assert.rejects(()=>capacity.assertAvailable('zero-plan',{db:fakeDb}),/sold out/i,'zero-capacity plan must reject new acquisition');
  assert(capacity.acquisitionSql('p').includes('p.capacity_limit IS NULL OR p.capacity_limit >'),'SQL acquisition guard must distinguish NULL/unlimited from zero/closed');
  console.log('plan zero-capacity staging smoke: OK');
})().catch(error=>{console.error(error.stack||error);process.exit(1);});
