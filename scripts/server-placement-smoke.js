'use strict';

const assert = require('assert');
const fs = require('fs');
const placement = require('../src/jellyfin/placement');
const plansList = require('../src/platform/admin-plans-list');
const capacity = require('../src/entitlements/plan-capacity');
require('../public/js/admin-plans-table');

const base = {
    health_status: 'healthy',
    max_users: 100,
    assigned_users: 10,
    active_streams: 5,
    priority: 100,
    placement_weight: 100
};

const a = { ...base, id: 'a', name: 'A', assigned_users: 20, active_streams: 2 };
const b = { ...base, id: 'b', name: 'B', assigned_users: 5, active_streams: 8 };
const c = { ...base, id: 'c', name: 'C', assigned_users: 10, active_streams: 1, health_status: 'degraded' };

assert.strictEqual(placement.normalizeStrategy('not-real'), 'balanced');
assert.strictEqual(placement.selectServer([], 'balanced'), null);
assert.strictEqual(placement.selectServer([a, b, c], 'lowest_customers').id, 'b');
assert.strictEqual(placement.selectServer([a, b, c], 'lowest_streams').id, 'a', 'healthy server should beat degraded server before stream count');
assert.strictEqual(placement.selectServer([a, b, c], 'balanced').id, 'b');
assert.strictEqual(placement.selectServer([a], 'manual').id, 'a');
assert.throws(() => placement.selectServer([a, b], 'manual'), /exactly one eligible/);

const sevenOfTen = { ...base, id: 'seven', name: 'Seven of ten', max_users: 10, assigned_users: 7 };
assert.strictEqual(placement.selectServer([sevenOfTen], 'balanced').id, 'seven', '7 managed customer users on a capacity-10 server must leave three places');
const tenOfTen = { ...base, id: 'ten', name: 'Ten of ten', max_users: 10, assigned_users: 10 };
assert.strictEqual(placement.selectServer([tenOfTen], 'balanced'), null, '10 managed customer users on a capacity-10 server must be full');

const weighted = [
    { ...base, id: 'one', name: 'One', placement_weight: 50 },
    { ...base, id: 'two', name: 'Two', placement_weight: 30 },
    { ...base, id: 'three', name: 'Three', placement_weight: 20 }
];
assert.strictEqual(placement.selectServer(weighted, 'weighted', { randomInt: () => 0 }).id, 'one');
assert.strictEqual(placement.selectServer(weighted, 'weighted', { randomInt: () => 50 }).id, 'three');
assert.strictEqual(placement.selectServer(weighted, 'weighted', { randomInt: () => 99 }).id, 'two');

const healthy = { ...base, id: 'healthy', name: 'Healthy', placement_weight: 1 };
const degradedHeavy = { ...base, id: 'degraded', name: 'Degraded', health_status: 'degraded', placement_weight: 10000 };
assert.strictEqual(
    placement.selectServer([degradedHeavy, healthy], 'weighted', { randomInt: () => 0 }).id,
    'healthy',
    'weighted placement must not send new accounts to a worse health tier while a healthier server is eligible'
);

assert.strictEqual(plansList.durationLabel({ billing_interval: 'trial', duration_days: 1 }), '24 hours');
assert.strictEqual(plansList.durationLabel({ billing_interval: 'month', duration_days: 30 }), '1 month');
assert.strictEqual(plansList.durationLabel({ billing_interval: '6_months', duration_days: 180 }), '6 months');
assert.strictEqual(plansList.durationLabel({ billing_interval: 'year', duration_days: 365 }), '1 year');
assert.strictEqual(plansList.durationLabel({ billing_interval: 'custom', duration_days: 45 }), '45 days');
assert.strictEqual(plansList.priceLabel({ price_minor: 0, currency: 'USD' }), 'Free');
assert.strictEqual(plansList.priceLabel({ price_minor: 600, currency: 'usd' }), '$6.00');

const capacitySource=fs.readFileSync('src/entitlements/plan-capacity.js','utf8');
const provisioningSource=fs.readFileSync('src/jellyfin/provisioning-helpers.js','utf8');
const durableSource=fs.readFileSync('src/jellyfin/durable-account-creation.js','utf8');
const userCapacitySource=fs.readFileSync('src/jellyfin/user-capacity.js','utf8');
const pendingRegistrationSource=fs.readFileSync('src/security/pending-registration.js','utf8');
const hardeningMigration=fs.readFileSync('db/migrations/20260908221500_post_681_runtime_hardening.sql','utf8');
const acquisition=capacity.acquisitionSql('p');
assert(capacitySource.includes("return'fleet_users'")&&capacitySource.includes('managedUsers')&&capacitySource.includes('pendingUsers')&&capacitySource.includes('reservedUsers'),'fleet capacity must be expressed as customer users, pending owed users and reservations');
assert(!capacitySource.includes("commercial_snapshot->'streams'")&&!capacitySource.includes('streamLimit')&&!capacitySource.includes('streamUsed')&&!capacitySource.includes('jellyfin_server_metrics'),'Jellyfin fleet capacity must not depend on stream entitlements or raw Jellyfin user metrics');
assert(acquisition.includes("capacity_account.account_purpose='jellyfin'")&&acquisition.includes('COUNT(DISTINCT capacity_account.customer_id)')&&acquisition.includes('pending_subscription.customer_id'),'acquisition SQL must count one managed customer per server and reserve pending entitled customers');
assert(!acquisition.includes("commercial_snapshot->'streams'")&&!acquisition.includes('occupancy_metric'),'acquisition SQL must not use stream weighting or Jellyfin total_users');
assert(userCapacitySource.includes('WITH capacity_users AS')&&userCapacitySource.includes('jellyfin_account_creation_intents')&&userCapacitySource.includes('jellyfin_server_placement_leases')&&userCapacitySource.includes('COUNT(DISTINCT customer_id)'),'server capacity truth must count durable users, creation intents and active leases exactly once per customer/server');
assert(provisioningSource.includes('async function reservePlacement')&&provisioningSource.includes('FOR UPDATE')&&provisioningSource.includes("error.code = 'JELLYFIN_SERVER_CAPACITY_CHANGED'")&&provisioningSource.includes('placementLeaseId: reservedServer.placement_lease_id'),'remote user creation must be preceded by a serialized server-capacity lease');
assert(durableSource.includes('access_lane,access_lane_changed_at')&&durableSource.includes('access_lane=EXCLUDED.access_lane')&&durableSource.includes('jellyfin_server_placement_leases'),'account lane and placement-lease consumption must persist in the same local transaction');
assert(hardeningMigration.includes('CREATE TABLE IF NOT EXISTS jellyfin_server_placement_leases')&&hardeningMigration.includes('UNIQUE(customer_id,server_id)'),'placement leases must be durable and unique per customer/server');
assert(capacitySource.includes('const fleetPlan=')&&capacitySource.includes('NOT ${fleetPlan}')&&capacitySource.includes('${fleetPlan} AND ${fleetConfigured} AND ${fleetAvailable}'),'fleet Jellyfin acquisition must fail closed instead of falling back to a plan capacity_limit');
assert(
    pendingRegistrationSource.includes('free_access_registration_intents')&&
    pendingRegistrationSource.includes('await planCapacity.assertAvailable(plan.id')&&
    pendingRegistrationSource.includes('await planCapacity.lockAndAssert(client,freePlan.id')&&
    pendingRegistrationSource.includes('INSERT INTO free_access_registration_reservations'),
    'anonymous Free signup must use a non-capacity intent, while validated account submission atomically reserves one fleet user place'
);
assert.strictEqual(capacity.capacityModel({service_type:'jellyfin',server_class:'free'}),'fleet_users');
assert.strictEqual(capacity.capacityModel({service_type:'bundle',server_class:'premium'}),'fleet_users');

(async()=>{
    const fakeDb=async sql=>{
        if(sql.includes('FROM plans WHERE id=$1'))return{rowCount:1,rows:[{id:'free-users',capacity_limit:999,service_type:'jellyfin',server_class:'free',billing_interval:'month',price_minor:0,is_free_tier:true}]};
        if(sql.includes("setting_key='operations_v1'"))return{rowCount:1,rows:[{setting_value:{placementHealthMode:'healthy_or_degraded'}}]};
        if(sql.includes('WITH restriction AS'))return{rowCount:1,rows:[{configured_servers:1,user_limit:10,managed_users:7}]};
        if(sql.includes('AS pending_users'))return{rowCount:1,rows:[{pending_users:2}]};
        if(sql.includes('FROM billing_checkout_intents i JOIN plans p'))return{rowCount:1,rows:[{reserved_users:0}]};
        if(sql.includes('FROM free_access_registration_reservations r JOIN plans p'))return{rowCount:1,rows:[{reserved_users:0}]};
        throw new Error(`Unexpected user-capacity query: ${sql.slice(0,120)}`);
    };
    const state=await capacity.usage('free-users',fakeDb);
    assert.strictEqual(state.model,'fleet_users');
    assert.strictEqual(state.userLimit,10,'server max_users is the pool user capacity');
    assert.strictEqual(state.managedUsers,7,'seven enabled managed customer users consume seven places');
    assert.strictEqual(state.pendingUsers,2,'two active customers still owed accounts reserve two places');
    assert.strictEqual(state.userUsed,9,'used capacity is managed users plus owed pending users');
    assert.strictEqual(state.remaining,1,'one place remains regardless of any plan stream allowance');
    assert.strictEqual(state.soldOut,false);
    assert.strictEqual(state.manualLimit,null,'plans.capacity_limit must not cap a Free/Premium Jellyfin fleet');

    const reservedDb=async sql=>{
        if(sql.includes('FROM plans WHERE id=$1'))return{rowCount:1,rows:[{id:'free-reserved',capacity_limit:null,service_type:'jellyfin',server_class:'free',billing_interval:'month',price_minor:0,is_free_tier:true}]};
        if(sql.includes("setting_key='operations_v1'"))return{rowCount:1,rows:[{setting_value:{placementHealthMode:'healthy_or_degraded'}}]};
        if(sql.includes('WITH restriction AS'))return{rowCount:1,rows:[{configured_servers:1,user_limit:10,managed_users:7}]};
        if(sql.includes('AS pending_users'))return{rowCount:1,rows:[{pending_users:2}]};
        if(sql.includes('FROM billing_checkout_intents i JOIN plans p'))return{rowCount:1,rows:[{reserved_users:0}]};
        if(sql.includes('FROM free_access_registration_reservations r JOIN plans p'))return{rowCount:1,rows:[{reserved_users:1}]};
        throw new Error(`Unexpected reservation query: ${sql.slice(0,120)}`);
    };
    const reserved=await capacity.usage('free-reserved',reservedDb);
    assert.strictEqual(reserved.remaining,0,'one validated pending-registration reservation consumes the final user place');
    assert.strictEqual(reserved.soldOut,true);

    const noServerDb=async sql=>{
        if(sql.includes('FROM plans WHERE id=$1'))return{rowCount:1,rows:[{id:'free-no-server',capacity_limit:3,service_type:'jellyfin',server_class:'free',billing_interval:'month',price_minor:0,is_free_tier:true}]};
        if(sql.includes("setting_key='operations_v1'"))return{rowCount:1,rows:[{setting_value:{placementHealthMode:'healthy_or_degraded'}}]};
        if(sql.includes('WITH restriction AS'))return{rowCount:1,rows:[{configured_servers:0,user_limit:0,managed_users:0}]};
        throw new Error(`Unexpected no-server query: ${sql.slice(0,120)}`);
    };
    const noServer=await capacity.usage('free-no-server',noServerDb);
    assert.strictEqual(noServer.remaining,0,'a plan capacity_limit must never advertise places when no Jellyfin server user capacity exists');
    assert.strictEqual(noServer.soldOut,true,'fleet plans with no Jellyfin server user capacity must fail closed');
    assert.match(noServer.fallbackReason,/server user capacity/);

    console.log('server placement + plans list + one-user-one-place capacity smoke: ok');
})().catch(error=>{console.error(error.stack||error);process.exit(1);});