'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '../src/payments/provider-operation-recovery.js'), 'utf8');
const matching = source.match(/async function matchingSchedule\([\s\S]*?\n\}/)?.[0] || '';
const missing = source.match(/function stripeResourceMissing\([\s\S]*?\n\}/)?.[0] || '';

assert(matching, 'provider recovery must retain a dedicated recorded-schedule lookup helper');
assert(missing, 'provider recovery must classify Stripe resource-missing errors explicitly');
assert(missing.includes('status === 404'), 'HTTP 404 may be treated as a genuinely missing Stripe schedule');
assert(missing.includes("code === 'resource_missing'"), 'Stripe resource_missing may be treated as a genuinely missing schedule');
assert(!matching.includes('catch (_) {}'), 'recorded Stripe schedule lookup must never swallow all provider errors');
assert.match(matching, /catch \(error\)[\s\S]*if \(!stripeResourceMissing\(error\)\) throw error;/, 'timeouts, 5xx, auth and network failures must propagate into provider-operation retry handling');

console.log('provider recovery safety smoke: ok');
