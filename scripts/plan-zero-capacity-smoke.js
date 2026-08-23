'use strict';

const fs=require('fs');
const assert=require('assert');
const capacity=require('../src/entitlements/plan-capacity');

const read=file=>fs.readFileSync(file,'utf8');
const create=read('src/platform/admin-plan-create-v2.js');
const inventory=read('src/platform/admin-plan-inventory.js');
const serverForm=read('views/admin/server-form.ejs');
const onboarding=read('views/customer/onboarding.ejs');
const storefront=read('src/platform/storefront.js');
const checkoutIntents=read('src/payments/checkout-intents.js');
const capacitySource=read('src/entitlements/plan-capacity.js');
const migration=read('db/migrations/000_database_baseline.sql');

assert(/capacityLimit\s*=\s*int\(body\.capacityLimit,\s*0,\s*1000000,\s*'Available slots'\)/.test(create),'new-plan backend must accept zero available slots');
assert(/capacityLimit:\s*input\.capacityLimit\s*\?\?\s*'0'/.test(create),'new plans must default to zero availability');
assert(create.includes('name="capacityLimit" required')&&create.includes('min="0" max="1000000"'),'new-plan browser control must allow zero slots for manual/fallback capacity');
assert(inventory.includes('name="capacityLimit" min="0" max="1000000"'),'manual Availability editor must allow zero slots');
assert(inventory.includes('Maximum simultaneous trials')&&inventory.includes('Maximum Stremio places'),'trials and Stremio must retain explicit manual acquisition caps');
assert(inventory.includes('controlled by server stream capacity'),'paid/free Jellyfin plan inventory must direct capacity changes to the server fleet');
assert(inventory.includes('Fleet stream capacity')&&inventory.includes('Sold / held streams'),'derived Jellyfin availability must expose the shared stream budget to administrators');
assert(inventory.includes('n<0||n>1000000'),'Availability backend must accept zero and reject negative manual limits');
assert(serverForm.includes('Sellable stream capacity')&&serverForm.includes('A 3-stream plan consumes 3 units'),'server configuration must explain that max_users is the sellable stream-entitlement budget');
assert(capacitySource.includes("commercial_snapshot->'streams'")&&capacitySource.includes('billing_checkout_intents'),'fleet usage must count snapshotted stream entitlements and open checkout holds');
assert(capacitySource.includes("key=model==='fleet_streams'?`fleet:${serverClass(plan)}`"),'fleet acquisition must serialize against a shared Premium/Free capacity lock');
assert(capacitySource.includes("health_status IN('healthy','degraded')")&&capacitySource.includes('temporarily unavailable fleet must resolve to zero capacity'),'fleet capacity must follow placement health and must not reopen legacy inventory during a drain/outage');
assert(checkoutIntents.includes("capacity.lockAndAssert(client,planId")&&checkoutIntents.includes('streams:snapshot.streams'),'paid checkout must reserve shared stream capacity atomically before creating an open intent');
assert(onboarding.includes('scarcityBadge')&&onboarding.includes('sharedCapacity'),'customer onboarding must surface shared fleet scarcity at the plan-family level');
assert(onboarding.includes("if(sold)")&&onboarding.includes('No new place can be activated until shared capacity becomes available.'),'sold-out Free, trial and paid plans must disable acquisition actions in the customer portal');
assert(storefront.includes('sectionAvailability')&&storefront.includes('state?.label'),'public storefront must use the real capacity scarcity label rather than synthetic inventory copy');
assert(/capacity_limit IS NULL\)\s+OR\s+\(capacity_limit >= 0\)|capacity_limit IS NULL OR capacity_limit >= 0/.test(migration),'database constraint must admit explicit zero capacity');

(async()=>{
  const fakeDb=async()=>({rowCount:1,rows:[{id:'zero-plan',capacity_limit:0,used:0}]});
  const state=await capacity.usage('zero-plan',fakeDb);
  assert.strictEqual(state.limit,0,'zero must remain an explicit numeric capacity');
  assert.strictEqual(state.remaining,0,'zero-capacity plan must report zero remaining');
  assert.strictEqual(state.soldOut,true,'zero-capacity plan must be sold out before any acquisition');
  await assert.rejects(()=>capacity.assertAvailable('zero-plan',{db:fakeDb}),/sold out/i,'zero-capacity plan must reject new acquisition');
  assert(capacity.acquisitionSql('p').includes('p.capacity_limit IS NULL OR p.capacity_limit >'),'SQL acquisition guard must preserve legacy/manual zero-capacity behavior');
  assert.deepStrictEqual(capacity.scarcity({remaining:2,soldOut:false,pool:'premium',plan:{billing_interval:'month',service_type:'jellyfin'}}),{label:'🔥 Only 2 Premium places left',kind:'urgent'},'real Premium scarcity must use exact low inventory');
  assert.deepStrictEqual(capacity.scarcity({remaining:8,soldOut:false,pool:'free',plan:{billing_interval:'month',service_type:'jellyfin'}}),{label:'Only 8 Free places left',kind:'limited'},'real Free scarcity must expose exact inventory below ten');
  assert.deepStrictEqual(capacity.scarcity({remaining:42,soldOut:false,pool:'premium',plan:{billing_interval:'month',service_type:'jellyfin'}}),{label:'Available',kind:'available'},'large capacity must not expose unnecessary inventory numbers');

  const unavailableFleetDb=async(sql)=>{
    if(sql.includes('FROM plans WHERE id=$1'))return{rowCount:1,rows:[{id:'fleet-plan',capacity_limit:99,service_type:'jellyfin',server_class:'premium',billing_interval:'month',price_minor:600,is_free_tier:false,streams:3}]};
    if(sql.includes("setting_key='operations_v1'"))return{rowCount:1,rows:[{setting_value:{placementHealthMode:'healthy_or_degraded'}}]};
    if(sql.includes('WITH restriction AS'))return{rowCount:1,rows:[{configured_servers:1,stream_limit:0}]};
    if(sql.includes('FROM subscriptions s JOIN plans p'))return{rowCount:1,rows:[{stream_used:0}]};
    if(sql.includes('FROM billing_checkout_intents i JOIN plans p'))return{rowCount:1,rows:[{stream_reserved:0}]};
    if(sql.includes('FROM free_access_registration_reservations r JOIN plans p'))return{rowCount:1,rows:[{stream_reserved:0}]};
    throw new Error(`Unexpected fleet-capacity query: ${sql.slice(0,120)}`);
  };
  const unavailable=await capacity.usage('fleet-plan',unavailableFleetDb);
  assert.strictEqual(unavailable.model,'fleet_streams','configured fleet must remain the capacity model while temporarily unavailable');
  assert.strictEqual(unavailable.streamLimit,0,'unavailable/drained eligible servers must contribute zero sellable stream capacity');
  assert.strictEqual(unavailable.remaining,0,'unavailable fleet must expose zero places');
  assert.strictEqual(unavailable.soldOut,true,'unavailable fleet must close acquisition instead of falling back to the legacy per-plan limit');

  console.log('plan zero-capacity and fleet-scarcity staging smoke: OK');
})().catch(error=>{console.error(error.stack||error);process.exit(1);});
