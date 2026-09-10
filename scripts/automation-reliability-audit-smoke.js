'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function source(relative) {
    return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

const critical = require('../src/automation/critical-jobs');
const jobs = require('../src/automation/jobs');
const attentionPolicy = require('../src/platform/actionable-attention-policy');
const integrity = require('../src/automation/revenue-integrity');

const requiredCritical = [
    'entitlements', 'billing', 'payment_events', 'provider_operation_recovery',
    'customer_deletions', 'creation_intent_recovery', 'customer_service_recovery',
    'revenue_integrity', 'email_outbox', 'notification_outbox', 'notification_lifecycle',
    'discord_roles', 'activation_cleanup'
];
for (const name of requiredCritical) {
    assert(critical.isCritical(name), `${name} must be a critical automation job`);
    assert.strictEqual(typeof jobs.jobs[name], 'function', `${name} must be registered in the automation worker registry`);
}

const worker = source('scripts/automation-worker.js');
for (const name of ['creation_intent_recovery', 'customer_service_recovery', 'revenue_integrity']) {
    assert(worker.includes(`${name}:60`), `${name} must default to a one-minute cadence`);
}

const retry = source('src/payments/payment-event-retry.js');
assert(retry.includes('provider=ANY($2::text[])'), 'payment retry claim must filter supported providers in SQL');
assert(retry.includes('claimSupportedRetryablePaymentEvents'), 'payment retry worker must use the supported-provider claim');

const termination = source('src/payments/subscription-termination.js');
assert(termination.includes('expectedSubscriptionId:subscription.id'), 'refund termination must scope Permanent Access revocation to the refunded subscription');
assert(termination.includes('Confirmed payment loss:'), 'refund termination must explicitly revoke subscription-pinned Permanent Access');

const providerOps = source('src/payments/provider-operations.js');
assert(providerOps.includes("operation_type!=='plan_change_immediate'"), 'provider operations must identify immediate plan changes');
assert(providerOps.includes('reconcileImmediatePlanAccess(op)'), 'reconciled immediate plan changes must wake access reconciliation');

const channelLinks = source('src/integrations/customer-channel-links.js');
assert(channelLinks.includes('alreadyLocked:true'), 'Discord unlink must revoke roles while still holding the same reconciliation lock');
assert(channelLinks.includes('previousDiscordUserId'), 'Discord unlink audit must retain the discarded identity for repairability');

for (const file of ['src/integrations/email-outbox.js', 'src/integrations/notification-outbox.js']) {
    const body = source(file);
    assert(body.includes('quarantineStaleSending'), `${file} must quarantine ambiguous in-flight delivery`);
    assert(!/status='sending'\s+AND\s+last_attempt_at<=NOW\(\)-make_interval/.test(body), `${file} must not automatically reclaim stale sending rows for resend`);
    assert(body.includes("status='dead'"), `${file} must make uncertain delivery operator-actionable`);
}

const jellyfinJobs = source('src/jellyfin/jobs.js');
assert(jellyfinJobs.includes('ensureFailureBackoff'), 'entitlement reconciliation must persist backoff for pre-state failures');

const inactivity = source('src/automation/customer-inactivity-scoped.js');
assert(inactivity.includes('MAX_ENFORCEMENTS_PER_RUN'), 'inactivity automation must have a destructive-run safety cap');
assert(inactivity.includes('deferred'), 'inactivity automation must report deferred eligible customers');

assert(attentionPolicy.IMMEDIATE_CRITICAL_JOBS.has('revenue_integrity'), 'integrity failures must surface immediately as critical');
assert(attentionPolicy.REQUIRED_ENABLED_JOBS.has('revenue_integrity'), 'integrity watchdog must not be silently disableable without attention');

const a = integrity.fingerprint([{ kind: 'b', id: '2' }, { kind: 'a', id: '1' }]);
const b = integrity.fingerprint([{ kind: 'a', id: '1' }, { kind: 'b', id: '2' }]);
assert.strictEqual(a, b, 'integrity alert fingerprint must be stable regardless of finding order');

const migration = source('db/migrations/20260910214500_automation_revenue_integrity.sql');
assert(migration.includes("'automation.integrity.failed'"), 'integrity alert notification preference must be migrated');
assert(migration.includes('plans_free_server_class_requires_free_tier'), 'database must prevent new paid-plan/free-pool contamination');

console.log('automation reliability audit smoke: ok');
