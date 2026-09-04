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

const remotelyFull = { ...base, id: 'remote-full', name: 'Remote full', max_users: 10, assigned_users: 7, capacity_users: 10 };
assert.strictEqual(
    placement.selectServer([remotelyFull], 'balanced'),
    null,
    'canonical occupancy must stop provisioning when Jellyfin itself is already full even if only seven managed accounts exist'
);

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
const pendingRegistrationSource=fs.readFileSync('src/security/pending-registration.js','utf8');
const acquisition=capacity.acquisitionSql('p');
assert(capacitySource.includes('enabledAccountFloor')&&capacitySource.includes('observedUserFloor')&&capacitySource.includes('placementUserFloor')&&capacitySource.includes('capacityGap'),'fleet runtime capacity must expose managed, observed and canonical placement occupancy');
assert(acquisition.includes('jellyfin_server_metrics occupancy_metric')&&acquisition.includes('COUNT(DISTINCT capacity_account.id)')&&acquisition.includes('server_load.capacity_users'),'fleet acquisition SQL must use the same managed-vs-live Jellyfin occupancy floor as placement');
assert(acquisition.includes("COALESCE(occupancy_server.media_server_type,'jellyfin')='jellyfin'")&&capacitySource.includes("COALESCE(js.media_server_type,'jellyfin')='jellyfin'"),'Jellyfin capacity must not count Emby or other media servers that provisioning cannot select');
assert(capacitySource.includes('const fleetPlan=')&&capacitySource.includes('NOT ${fleetPlan}')&&capacitySource.includes('${fleetPlan} AND ${fleetConfigured} AND ${fleetAvailable}'),'fleet Jellyfin acquisition must fail closed instead of falling back to a manual plan limit when no server capacity is configured');
assert(pendingRegistrationSource.includes('async function reserveFreeAccess')&&pendingRegistrationSource.includes('await planCapacity.lockAndAssert(client,plan.id')&&pendingRegistrationSource.includes('INSERT INTO free_access_registration_reservations'),'Free Access reservation must consume derived fleet capacity even when plans.capacity_limit is null');

(async()=>{
    const fakeDb=async sql=>{
        if(sql.includes('FROM plans WHERE id=$1'))return{rowCount:1,rows:[{id:'free-floor',capacity_limit:null,service_type:'jellyfin',server_class:'free',billing_interval:'month',price_minor:0,is_free_tier:true,streams:1}]};
        if(sql.includes("setting_key='operations_v1'"))return{rowCount:1,rows:[{setting_value:{placementHealthMode:'healthy_or_degraded'}}]};
        if(sql.includes('WITH restriction AS'))return{rowCount:1,rows:[{configured_servers:1,stream_limit:10,enabled_accounts:7,observed_users:10,placement_users:10}]};
        if(sql.includes('AS stream_used'))return{rowCount:1,rows:[{stream_used:2}]};
        if(sql.includes('FROM billing_checkout_intents i JOIN plans p'))return{rowCount:1,rows:[{stream_reserved:0}]};
        if(sql.includes('FROM free_access_registration_reservations r JOIN plans p'))return{rowCount:1,rows:[{stream_reserved:0}]};
        throw new Error(`Unexpected capacity-floor query: ${sql.slice(0,120)}`);
    };
    const floor=await capacity.usage('free-floor',fakeDb);
    assert.strictEqual(floor.entitlementStreamUsed,2,'subscription demand must remain visible independently');
    assert.strictEqual(floor.enabledAccountFloor,7,'managed Jellyfin accounts must remain visible independently');
    assert.strictEqual(floor.observedUserFloor,10,'fresh Jellyfin inventory must expose unmanaged users that placement can see');
    assert.strictEqual(floor.placementUserFloor,10,'canonical occupancy must use the per-server maximum of managed and fresh Jellyfin users');
    assert.strictEqual(floor.capacityGap,8,'capacity diagnostics must expose placement users not explained by current entitlement demand');
    assert.strictEqual(floor.streamUsed,10,'effective occupancy must match the placement occupancy floor');
    assert.strictEqual(floor.remaining,0,'a remotely full server must not advertise the three false Free places implied by seven managed accounts');
    assert.strictEqual(floor.soldOut,true,'remote Jellyfin exhaustion must close acquisition before provisioning');

    const noServerDb=async sql=>{
        if(sql.includes('FROM plans WHERE id=$1'))return{rowCount:1,rows:[{id:'free-no-server',capacity_limit:3,service_type:'jellyfin',server_class:'free',billing_interval:'month',price_minor:0,is_free_tier:true,streams:1}]};
        if(sql.includes("setting_key='operations_v1'"))return{rowCount:1,rows:[{setting_value:{placementHealthMode:'healthy_or_degraded'}}]};
        if(sql.includes('WITH restriction AS'))return{rowCount:1,rows:[{configured_servers:0,stream_limit:0,enabled_accounts:0,observed_users:0,placement_users:0}]};
        throw new Error(`Unexpected no-server query: ${sql.slice(0,120)}`);
    };
    const noServer=await capacity.usage('free-no-server',noServerDb);
    assert.strictEqual(noServer.remaining,0,'a manual capacity_limit must never advertise Free places when no Jellyfin server capacity exists');
    assert.strictEqual(noServer.soldOut,true,'fleet plans with no Jellyfin server capacity must fail closed');
    assert.match(noServer.fallbackReason,/No Jellyfin server capacity/);

    console.log('server placement + plans list + truthful fleet capacity smoke: ok');
})().catch(error=>{console.error(error.stack||error);process.exit(1);});
