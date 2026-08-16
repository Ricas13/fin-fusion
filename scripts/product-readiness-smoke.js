'use strict';

const assert = require('assert');
const readiness = require('../src/platform/product-readiness');

const base = {
  active: true,
  visible: true,
  archived_at: null,
  effective_from: null,
  effective_until: null,
  service_type: 'jellyfin'
};

const good = { stremio: { runtimeReady: true, eligibleServers: 1, readyIndexes: 1 } };
const noRuntime = { stremio: { runtimeReady: false, eligibleServers: 1, readyIndexes: 1 } };
const noServer = { stremio: { runtimeReady: true, eligibleServers: 0, readyIndexes: 0 } };
const noIndex = { stremio: { runtimeReady: true, eligibleServers: 1, readyIndexes: 0 } };

assert.equal(readiness.evaluate(base, good).key, 'live');
assert.equal(readiness.evaluate({ ...base, visible: false }, good).key, 'hidden');
assert.equal(readiness.evaluate({ ...base, active: false }, good).key, 'inactive');
assert.equal(readiness.evaluate({ ...base, archived_at: new Date() }, good).key, 'archived');
assert.equal(readiness.evaluate({ ...base, service_type: 'stremio' }, noRuntime).key, 'runtime_unavailable');
assert.equal(readiness.evaluate({ ...base, service_type: 'stremio' }, noServer).key, 'no_delivery_server');
assert.equal(readiness.evaluate({ ...base, service_type: 'bundle' }, noIndex).key, 'index_not_ready');
assert.equal(readiness.evaluate({ ...base, service_type: 'bundle' }, good).key, 'live');
assert.equal(readiness.deliveryLabel({ service_type: 'bundle' }), 'Jellyfin + Stremio');

console.log('product readiness smoke: ok');
