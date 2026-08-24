'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const expiry = require('../src/entitlements/subscription-expiry');

const expirySource = read('src/entitlements/subscription-expiry.js');
const jobs = read('src/automation/jobs.js');
const emailOutbox = read('src/integrations/email-outbox.js');
const secondaryOutbox = read('src/integrations/notification-outbox.js');

// Active provider subscriptions renew automatically and must not receive a
// misleading monthly "expires soon" warning. Non-recurring, trial/past-due and
// cancelled access remains eligible for an access-expiry warning.
assert.strictEqual(expiry.recurringAutoRenewal({ status: 'active', source: 'stripe', provider_subscription_id: 'sub_123' }), true);
assert.strictEqual(expiry.recurringAutoRenewal({ status: 'active', source: 'paypal', provider_subscription_id: 'I-ABC123' }), true);
assert.strictEqual(expiry.recurringAutoRenewal({ status: 'cancelled', source: 'stripe', provider_subscription_id: 'sub_123' }), false);
assert.strictEqual(expiry.recurringAutoRenewal({ status: 'past_due', source: 'paypal', provider_subscription_id: 'I-ABC123' }), false);
assert.strictEqual(expiry.recurringAutoRenewal({ status: 'active', source: 'service_credit', provider_subscription_id: null }), false);
assert(expiry.DEFAULT_WARNING_DAYS >= 1 && expiry.DEFAULT_WARNING_DAYS <= 30, 'expiry warning window must stay bounded');

// Warning discovery must not repeat a fixed first page forever. Dedupe happens
// at the durable outbox; the scan itself deliberately has no LIMIT starvation.
assert(expirySource.includes("eventType: 'subscription.expiring'"), 'subscription expiry must produce the configured notification event');
assert(expirySource.includes('subscription-expiring:${row.id}:${endKey}'), 'expiry warnings must have a stable subscription/period dedupe key');
assert(!/async function expiringSubscriptions[\s\S]*?LIMIT\s+\$\d/i.test(expirySource), 'expiry warning discovery must not use a fixed SQL LIMIT');
assert(expirySource.includes("COALESCE(p.is_free_tier,FALSE)=FALSE"), 'non-expiring Free Access must not receive expiry warnings');
assert(jobs.includes('subscriptionExpiry.notifyExpiringSubscriptions()'), 'the existing entitlement automation must generate expiry warnings');
assert(jobs.indexOf('subscriptionExpiry.notifyExpiringSubscriptions()') < jobs.indexOf('expireSubscriptionsAndReconcile()'), 'warnings must be checked before due subscriptions are expired');

// Email and secondary messaging use one physical table. Each worker must claim,
// retry and report only its own rows or the workers can steal incompatible
// encrypted payloads from one another.
assert(emailOutbox.includes("INSERT INTO notification_outbox(channel,message_type,recipient_email"), 'email enqueue must identify its channel explicitly');
assert(emailOutbox.includes("VALUES('email',$1,$2,$3,$4,'pending',NOW())"), 'email rows must be persisted with channel=email');
for (const fragment of [
    "WHERE channel='email' AND status IN ('pending','failed')",
    "WHERE id=$1 AND channel='email'",
    "FROM notification_outbox WHERE channel='email' ORDER BY created_at DESC",
    "WHERE channel='email'"
]) assert(emailOutbox.includes(fragment), `email outbox is missing channel isolation: ${fragment}`);
assert(secondaryOutbox.includes("WHERE channel<>'email' AND status IN('pending','failed')"), 'secondary worker must remain isolated from email rows');
assert(secondaryOutbox.includes("WHERE channel<>'email' ORDER BY created_at DESC"), 'secondary delivery history must remain isolated from email rows');

console.log('workflow notification correctness smoke: ok');
