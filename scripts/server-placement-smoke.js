'use strict';

const assert = require('assert');
const placement = require('../src/jellyfin/placement');
const plansList = require('../src/platform/admin-plans-list');
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
assert.strictEqual(plansList.priceLabel({ price_minor: 600, currency: 'usd' }), 'USD 6.00');

console.log('server placement + plans list smoke: ok');
