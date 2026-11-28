'use strict';

const assert = require('node:assert/strict');
const { advance, MAX_POLL_GAP_SECONDS } = require('../src/jellyfin/playback-accounting-core');

const base = Date.parse('2026-11-05T12:00:00Z');
const at = seconds => new Date(base + seconds * 1000);
const observation = (seconds, extra = {}) => ({
  startedAt: at(0),
  at: at(seconds),
  positionTicks: null,
  isPaused: false,
  source: 'poll',
  event: 'progress',
  ...extra
});

let state = advance(null, observation(0));
assert.equal(state.watchSeconds, 0, 'first observation cannot invent previous viewing');
state = advance(state, observation(20, { positionTicks: 200000000 }));
assert.equal(state.watchSeconds, 20);
assert.equal(state.confirmedSeconds, 0, 'first position sample does not establish movement');
state = advance(state, observation(40, { positionTicks: 400000000 }));
assert.equal(state.watchSeconds, 40);
assert.equal(state.confirmedSeconds, 20, 'position progression corroborates credit');

state = advance(state, observation(45, { isPaused: true, event: 'pause', positionTicks: 450000000 }));
assert.equal(state.watchSeconds, 45, 'pause boundary credits preceding playing seconds');
state = advance(state, observation(300, { isPaused: true, positionTicks: 450000000 }));
assert.equal(state.watchSeconds, 45, 'long pause is not watched');
state = advance(state, observation(301, { isPaused: false, event: 'resume', positionTicks: 450000000 }));
assert.equal(state.watchSeconds, 45, 'resume does not credit the pause');
state = advance(state, observation(321, { positionTicks: 650000000 }));
assert.equal(state.watchSeconds, 65);
assert.equal(state.confirmedSeconds, 45);
const once = state;
state = advance(state, observation(321, { positionTicks: 650000000 }));
assert.equal(state, once, 'duplicate events are idempotent');
state = advance(state, observation(290, { positionTicks: 450000000 }));
assert.equal(state, once, 'out-of-order events cannot reduce counters');

const seek = advance(state, observation(341, { positionTicks: 480000000000 }));
assert.equal(seek.watchSeconds, 85, 'a seek cannot invent extra watched minutes');
assert.equal(seek.confirmedSeconds, 45, 'large jump is not confirmation');

let missing = advance(null, observation(0));
missing = advance(missing, observation(600));
assert.equal(missing.watchSeconds, MAX_POLL_GAP_SECONDS, 'outage gap has a fixed poll cap');

let webhook = advance(null, observation(0, { source: 'webhook', event: 'start' }));
webhook = advance(webhook, observation(1158, { source: 'webhook', event: 'stop' }));
assert.equal(webhook.watchSeconds, 1158, 'explicit stop bridges a start-only session');
assert.equal(webhook.confirmedSeconds, 0, 'start-only duration remains an estimate');
assert.equal(webhook.ended, true);
assert.equal(advance(webhook, observation(1200)), webhook, 'stopped session cannot accrue more');

const restarted = advance(webhook, {
  ...observation(1300),
  startedAt: at(1200)
});
assert.equal(restarted.watchSeconds, 0, 'new playback segment resets the watch accumulator');
assert.equal(restarted.samples, 1);

assert.equal(advance(null, observation(-100)), null,
  'an event before the segment starts must not create watch history');

console.log('native playback accounting smoke: ok');
