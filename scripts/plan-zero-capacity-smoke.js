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
const plansList=read('src/platform/admin-plans-list.js');
const lifecycle=read('src/payments/lifecycle.js');
const migration=read('db/migrations/000_database_baseline.sql');

assert(/capacityLimit\s*=\s*int\(body\.capacityLimit,\s*0,\s*1000000,\s*'Available slots'\)/.test(create),'new-plan backend must accept zero available slots');
assert(/capacityLimit:\s*input\.capacityLimit\s*\?\?\s*'0'/.test(create),'new plans must default to zero availability');
assert(create.includes('name="capacityLimit" required')&&create.includes('min="0" max="1000000"'),'new-plan browser control must allow zero slots for manual/fallback capacity');
assert(inventory.includes('name="capacityLimit" min="0" max="1000000"'),'manual Availability editor must allow zero slots');
assert(inventory.includes('Maximum simultaneous trials')&&inventory.includes('Stremio household capacity'),'trials and Stremio must retain explicit manual acquisition caps with household-unit semantics');
assert(inventory.includes('Sold / held households')&&inventory.includes('multi-household purchases consume the correct amount'),'Stremio Availability must explain household-unit inventory to administrators');
assert(inventory.includes('controlled by server stream capacity'),'paid/free Jellyfin plan inventory must direct capacity changes to the server fleet');
assert(inventory.includes('Fleet stream capacity')&&inventory.includes('Sold / held streams'),'derived Jellyfin availability must expose the shared stream budget to administrators');
assert(inventory.includes('n<0||n>1000000'),'Availability backend must accept zero and reject negative manual limits');
assert(serverForm.includes('Sellable stream capacity')&&serverForm.includes('A 3-stream plan consumes 3 units'),'server configuration must explain that max_users is the sellable stream-entitlement budget');
assert(capacitySource.includes("commercial_snapshot->'streams'")&&capacitySource.includes('billing_checkout_intents'),'fleet usage must count snapshotted stream entitlements and open checkout holds');
assert(capacitySource.includes("commercial_snapshot->'stremioHouseholdNetworkLimit'")&&capacitySource.includes('async function stremioHouseholdUsage'),'Stremio usage must count purchased and held household units');
assert(capacitySource.includes("key=model==='fleet_streams'?`fleet:${serverClass(plan)}`"),'fleet acquisition must serialize against a shared Premium/Free capacity lock');
assert(capacitySource.includes("health_status IN('healthy','degraded')")&&capacitySource.includes("COALESCE(js.placement_mode,'active')='active'")&&capacitySource.includes('configured_servers'),'fleet capacity must follow placement health/state and retain an explicit configured-fleet signal during drain/outage');
assert(checkoutIntents.includes("capacity.lockAndAssert(client,planId")&&checkoutIntents.includes('streams:snapshot.streams')&&checkoutIntents.includes('households:snapshot.stremioHouseholdNetworkLimit'),'checkout must reserve the selected Jellyfin stream or Stremio household capacity atomically');
assert(onboarding.includes('scarcityBadge')&&onboarding.includes('sharedCapacity'),'customer onboarding must surface shared fleet scarcity at the plan-family level');
assert(onboarding.includes("if(sold)")&&onboarding.includes('No new place can be activated until capacity becomes available.'),'sold-out plans must disable acquisition actions in the customer portal');
assert(storefront.includes('sectionAvailability')&&storefront.includes('state?.label'),'public storefront must use the real capacity scarcity label rather than synthetic inventory copy');
assert(lifecycle.includes("capacity.acquisitionSql('p')")&&lifecycle.includes('capacity.lockAndAssert(client,plan.id'),'payment/free/trial acquisition must retain the SQL prefilter plus locked authoritative recheck');
assert(plansList.includes('${active} active + ${held} held / ${limit} stream slots'),'admin plan capacity must distinguish active stream use from temporary holds');
assert(/capacity_limit IS NULL\)\s+OR\s+\(capacity_limit >= 0\)|capacity_limit IS NULL OR capacity_limit >= 0/.test(migration),'database constraint must admit explicit zero capacity');

(async()=>{
  const fakeDb=async()=>({rowCount:1,rows:[{id:'zero-plan',capacity_limit:0,used:0}]});
  const state=await capacity.usage('zero-plan',fakeDb);
  assert.strictEqual(state.limit,0,'zero must remain an explicit numeric capacity');
  assert.strictEqual(state.remaining,0,'zero-capacity plan must report zero remaining');
  assert.strictEqual(state.soldOut,true,'zero-capacity plan must be sold out before any acquisition');
  await assert.rejects(()=>capacity.assertAvailable('zero-plan',{db:fakeDb}),/sold out/i,'zero-capacity plan must reject new acquisition');
  const acquisition=capacity.acquisitionSql('p');
  assert(acquisition.includes('p.capacity_limit IS NULL OR p.capacity_limit >'),'SQL acquisition guard must preserve legacy/manual zero-capacity behavior');
  assert(acquisition.includes('SUM(capacity_server.max_users)')&&acquisition.includes("active_subscription.commercial_snapshot->'streams'")&&acquisition.includes("capacity_checkout.commercial_snapshot->'streams'"),'fleet SQL acquisition must compare eligible stream capacity with active and checkout stream units');
  assert(acquisition.includes('capacity_free_hold.consumed_at IS NULL')&&acquisition.includes('capacity_free_hold.released_at IS NULL'),'fleet SQL acquisition must count pending Free Access holds');
  assert(acquisition.includes('GREATEST(1,COALESCE(p.streams,1))'),'fleet SQL acquisition must reserve enough room for the next plan-sized stream entitlement');
  assert(acquisition.includes('plan_server_eligibility capacity_restriction')&&acquisition.includes('plan_server_eligibility capacity_match'),'fleet SQL acquisition must honor plan-specific server eligibility when detecting/configuring capacity');
  assert(acquisition.includes("setting_value->>'placementHealthMode'")&&acquisition.includes("capacity_server.placement_mode,'active'"),'fleet SQL acquisition must use the same health and placement admission signals as runtime capacity');
  assert(acquisition.includes("p.billing_interval<>'trial' OR")&&acquisition.includes('NOT (p.service_type=\'jellyfin\''),'fleet SQL acquisition must retain manual trial/fallback capacity instead of replacing it');
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

  console.log('plan zero-capacity and fleet/household scarcity staging smoke: OK');
})().catch(error=>{console.error(error.stack||error);process.exit(1);});
