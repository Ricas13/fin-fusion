'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function source(relative) {
    return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

const resilient = source('src/jellyfin/resilient-provisioning.js');
const expiry = source('src/entitlements/subscription-expiry.js');
const retry = source('src/entitlements/automatic-free-downgrade-retry.js');
const jobs = source('src/automation/jobs.js');
const packageJson = require('../package.json');

const wrapperStart = resilient.indexOf('async function maybeAutoDowngrade');
const expiryStart = resilient.indexOf('async function expireSubscriptionsAndReconcile', wrapperStart);
assert(wrapperStart >= 0 && expiryStart > wrapperStart, 'canonical reconciler must retain the automatic downgrade wrapper');
const wrapper = resilient.slice(wrapperStart, expiryStart);
assert(wrapper.includes('autoDowngradeEligibleCustomer(customerId)'), 'automatic downgrade wrapper must call the lifecycle owner');
assert(wrapper.includes('throw error;'), 'automatic downgrade wrapper must propagate failures to the durable retry owner');
assert(!wrapper.includes('return null;'), 'automatic downgrade wrapper must not turn failures into a false no-op result');

assert(expiry.includes("require('./automatic-free-downgrade-retry')"), 'subscription expiry must own durable automatic downgrade failure persistence');
assert(/catch \(error\) \{[\s\S]*automaticFreeDowngradeRetry\.enqueue\(customerId, error\)/.test(expiry), 'automatic downgrade exceptions must be durably enqueued by subscription expiry');
assert(expiry.includes('try { await reconcileCustomer(customerId); }'), 'paid expiry must still reconcile closed after a failed Free downgrade');

assert(retry.includes('FOR UPDATE SKIP LOCKED'), 'automatic downgrade retries must be claimed safely across workers');
assert(retry.includes('next_attempt_at=NOW()+make_interval'), 'automatic downgrade retry failures must back off');
assert(retry.includes("subscription.free.auto_downgrade.retry_resolved"), 'resolved automatic downgrade retries must be auditable');
assert(jobs.includes('automaticFreeDowngradeRetry.processDue'), 'entitlement automation must process durable automatic downgrade retries');

assert(String(packageJson.scripts['check:db'] || '').includes('automatic-free-downgrade-retry-db-smoke.js'), 'automatic downgrade retry DB regression must run in check:db');

console.log('automatic Free downgrade retry ownership smoke: ok');
