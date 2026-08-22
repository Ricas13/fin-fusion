'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parse, form, values } = require('../src/platform/admin-plan-create-v2');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/platform/admin-plan-create-v2.js'), 'utf8');
const browser = fs.readFileSync(path.join(root, 'public/js/admin-plan-create-v2.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/admin-adaptive-plans.css'), 'utf8');
const capabilityCss = fs.readFileSync(path.join(root, 'public/css/admin-capability.css'), 'utf8');

function base(overrides = {}) {
  return {
    code: 'test-plan',
    name: 'Test plan',
    capacityLimit: '0',
    visible: 'on',
    active: 'on',
    jellyfinAccessModel: 'concurrent_streams',
    streams: '3',
    libraryAccessMode: 'all',
    playbackWindowDays: '7',
    minimumObservationHours: '24',
    ...overrides
  };
}

const free = parse(base({ planKind: 'free_jellyfin' }), 'GBP');
assert.equal(free.planKind, 'free_jellyfin');
assert.equal(free.serviceType, 'jellyfin');
assert.equal(free.priceMinor, 0, 'free Jellyfin must force a zero price');
assert.equal(free.billing, 'month', 'free Jellyfin keeps a canonical internal billing value');
assert.equal(free.duration, 30, 'free Jellyfin keeps a canonical internal duration');
assert.equal(free.serverClass, 'free', 'free Jellyfin must force free placement class');

const paid = parse(base({ planKind: 'paid_jellyfin', price: '6.00', billingInterval: 'month', serverClass: 'premium' }), 'GBP');
assert.equal(paid.planKind, 'paid_jellyfin');
assert.equal(paid.priceMinor, 600);
assert.equal(paid.serverClass, 'premium');
assert.equal(paid.streams, 3);

const stremio = parse(base({
  planKind: 'stremio',
  price: '5.00',
  billingInterval: 'month',
  stremioHouseholdNetworkLimit: '4',
  stremioHouseholdLeaseMinutes: '240',
  stremioIpReplacementPolicy: 'customer_cooldown',
  stremioIpReplacementCooldownMinutes: '720'
}), 'GBP');
assert.equal(stremio.serviceType, 'stremio');
assert.equal(stremio.stremioHouseholdNetworkLimit, 4, 'Stremio creation must allow more than one household connection');
assert.equal(stremio.stremioIpReplacementPolicy, 'customer_cooldown');
assert.equal(stremio.stremioIpReplacementCooldownMinutes, 720);
assert.equal(stremio.streams, 1, 'legacy storage value remains internal; UI promises unlimited Stremio playback');
assert.throws(() => parse(base({ planKind: 'stremio', price: '5.00', billingInterval: 'month', stremioHouseholdNetworkLimit: '11' }), 'GBP'), /household connections/i);

const req = { session: {}, query: {} };
const freeHtml = form(req, { __submitted: '1', planKind: 'free_jellyfin', code: 'free-plan', name: 'Free', capacityLimit: '0' }, '', 'GBP');
assert.match(freeHtml, /What are you selling\?/);
assert.match(freeHtml, /Free Jellyfin/);
assert.match(freeHtml, /Paid Jellyfin/);
assert.match(freeHtml, /Household connections/);
assert.match(freeHtml, /data-commercial-card hidden/, 'free plan should render commercial card hidden');
assert.match(freeHtml, /data-free-lifecycle/, 'free lifecycle controls remain available');

const stremioHtml = form({ session: {}, query: { type: 'stremio' } }, {}, '', 'GBP');
assert.match(stremioHtml, /name="stremioHouseholdNetworkLimit"/);
assert.match(stremioHtml, /Unlimited streams/);
assert.match(stremioHtml, /data-stremio-access/);

assert.match(source, /stremio_household_network_limit/);
assert.match(source, /stremio_ip_replacement_policy/);
assert.match(source, /stremio_ip_replacement_cooldown_minutes/);
assert.doesNotMatch(source, /child_process|execSync|spawnSync/);
assert.match(browser, /free_jellyfin/);
assert.match(browser, /paid_jellyfin/);
assert.match(browser, /data-plan-kind/);
assert.match(css, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
assert.match(css, /@media\(max-width:820px\)/);
assert.match(css, /grid-template-columns:1fr/);
assert.match(capabilityCss, /admin-adaptive-plans\.css/);

const defaults = values({ query: { type: 'free' } }, {}, 'GBP');
assert.equal(defaults.planKind, 'free_jellyfin');
assert.equal(defaults.price, '0.00');
assert.equal(defaults.serverClass, 'free');

console.log('Adaptive plan creation smoke checks passed.');
