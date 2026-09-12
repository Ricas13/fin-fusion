'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function source(relative) {
    return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

function between(body, start, end) {
    const from = body.indexOf(start);
    assert(from >= 0, `Missing source marker: ${start}`);
    const to = end ? body.indexOf(end, from + start.length) : body.length;
    return body.slice(from, to < 0 ? body.length : to);
}

const critical = require('../src/automation/critical-jobs');
const jobs = require('../src/automation/jobs');
const attentionPolicy = require('../src/platform/actionable-attention-policy');
const integrity = require('../src/automation/revenue-integrity');
const integrityFreshness = require('../src/integrations/integrity-alert-freshness');

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

const emailOutbox = source('src/integrations/email-outbox.js');
const emailClaim = between(emailOutbox, 'async function claimOne()', 'async function recordConfirmedFailure');
assert(emailOutbox.includes('quarantineStaleSending'), 'email outbox must quarantine ambiguous in-flight delivery');
assert(emailClaim.includes("status IN ('pending','failed')"), 'email claim must only lease confirmed retryable states');
assert(!emailClaim.includes("(status='sending' AND last_attempt_at"), 'email claim must not automatically reclaim an ambiguous sending row');
assert(!emailClaim.includes("OR (status='sending'"), 'email claim must not include sending rows in retry eligibility');
assert(emailOutbox.includes("status='dead'"), 'email uncertain delivery must become operator-actionable');
assert(emailOutbox.includes('freshness.nextAttemptAt'), 'integrity email alerts must receive a self-healing grace window before delivery');
assert(emailOutbox.includes('freshness.cancelIfStale'), 'email delivery must revalidate integrity alerts before external send');
assert(emailOutbox.includes("status<>'cancelled'"), 'suppressed integrity emails must not be manually revived by the generic retry action');

const notificationOutbox = source('src/integrations/notification-outbox.js');
const notificationClaim = between(notificationOutbox, 'async function claim(', 'function retryAt');
assert(notificationOutbox.includes('quarantineStaleSending'), 'notification outbox must quarantine ambiguous in-flight delivery');
assert(notificationClaim.includes("status IN('pending','failed')"), 'notification claim must only lease confirmed retryable states');
assert(!notificationClaim.includes("OR status='sending'"), 'notification claim must not include sending rows in retry eligibility');
assert(!notificationClaim.includes("status IN('pending','failed','sending')"), 'notification claim must never lease sending rows');
assert(notificationOutbox.includes("status='dead'"), 'notification uncertain delivery must become operator-actionable');
assert(notificationClaim.includes('dedupe_key'), 'chat notification claims must retain the integrity snapshot fingerprint for freshness checks');
assert(notificationOutbox.includes('freshness.nextAttemptAt'), 'integrity Discord/Telegram alerts must receive a self-healing grace window before delivery');
assert(notificationOutbox.includes('freshness.cancelIfStale'), 'Discord/Telegram delivery must revalidate integrity alerts before external send');

const jellyfinJobs = source('src/jellyfin/jobs.js');
assert(jellyfinJobs.includes('ensureFailureBackoff'), 'entitlement reconciliation must persist backoff for pre-state failures');

const creationRecovery = source('src/automation/jellyfin-creation-intent-recovery.js');
assert(creationRecovery.includes("admin?.mode === 'admin_present'"), 'creation-intent recovery must preserve explicit admin-present authority');
assert(creationRecovery.includes('beforeDelete'), 'creation-intent cleanup must re-check authority before remote deletion');

const inactivity = source('src/automation/customer-inactivity-scoped.js');
assert(inactivity.includes('MAX_ENFORCEMENTS_PER_RUN'), 'inactivity automation must have a destructive-run safety cap');
assert(inactivity.includes('deferred'), 'inactivity automation must report deferred eligible customers');

assert(attentionPolicy.IMMEDIATE_CRITICAL_JOBS.has('revenue_integrity'), 'integrity failures must surface immediately as critical');
assert(attentionPolicy.REQUIRED_ENABLED_JOBS.has('revenue_integrity'), 'integrity watchdog must not be silently disableable without attention');
assert(attentionPolicy.IMMEDIATE_WARNING_JOBS.has('email_outbox'), 'email delivery failures must surface on their first degraded automation pass');
assert(attentionPolicy.IMMEDIATE_WARNING_JOBS.has('notification_outbox'), 'Discord/Telegram delivery failures must surface on their first degraded automation pass');

const integritySource = source('src/automation/revenue-integrity.js');
assert(integritySource.includes('notification_delivery_uncertain'), 'integrity watchdog must persistently surface quarantined uncertain notification deliveries');
assert(integritySource.includes("status='sending'"), 'integrity watchdog must detect notification rows stuck in sending state');

const deploymentVerification = source('scripts/verify-deployment.js');
assert(deploymentVerification.includes("'degraded'"), 'deployment verification must reject degraded critical automation jobs');
assert(deploymentVerification.includes('badStates.has(jobHealth.healthState(job))'), 'critical deployment verification must evaluate the hardened bad-state set');
assert(deploymentVerification.includes('DEPLOYMENT_PROBE_JOBS'), 'deployment verification must define the live recovery automation probe set');
assert(deploymentVerification.includes('jobHealth.requestRun(jobKey)'), 'deployment verification must force the recovery probe through the real automation worker');
assert(deploymentVerification.includes("SELECT NOW() AS marker"), 'deployment automation probe must compare completion using the database clock');
assert(deploymentVerification.includes("add('automation recovery probe'"), 'post-deploy automation execution must be a visible deployment gate');

const a = integrity.fingerprint([{ kind: 'b', id: '2' }, { kind: 'a', id: '1' }]);
const b = integrity.fingerprint([{ kind: 'a', id: '1' }, { kind: 'b', id: '2' }]);
assert.strictEqual(a, b, 'integrity alert fingerprint must be stable regardless of finding order');

const integrityDedupe = `admin:test:discord:automation-integrity:${a}:12345`;
assert.strictEqual(integrityFreshness.fingerprintFromDedupeKey(integrityDedupe), a, 'integrity delivery guard must recover the queued snapshot fingerprint');
assert.strictEqual(integrityFreshness.fingerprintFromDedupeKey('ordinary-notification'), null, 'ordinary notifications must not be freshness-gated');
const now = Date.now();
const delayed = integrityFreshness.nextAttemptAt(integrityDedupe, now).getTime();
assert.strictEqual(delayed - now, integrityFreshness.INTEGRITY_ALERT_GRACE_MS, 'integrity alerts must wait for the self-healing grace interval');
assert(integrityFreshness.INTEGRITY_ALERT_GRACE_MS >= 30000, 'integrity alert grace must be long enough for a normal automation retry pass');

const freshnessSource = source('src/integrations/integrity-alert-freshness.js');
assert(freshnessSource.includes("status='cancelled'"), 'stale integrity alerts must become cancelled rather than sent or dead');
assert(freshnessSource.includes('dedupe_key=NULL'), 'cancelled stale alerts must release their dedupe key so a genuinely recurring failure can alert again');
assert(freshnessSource.includes('integrity.scan()'), 'delivery freshness must re-scan current integrity immediately before external send');

const migration = source('db/migrations/20260910214500_automation_revenue_integrity.sql');
assert(migration.includes("'automation.integrity.failed'"), 'integrity alert notification preference must be migrated');
assert(migration.includes('plans_free_server_class_requires_free_tier'), 'database must prevent new paid-plan/free-pool contamination');
assert(migration.includes('customer_deletion_target_parent_heartbeat'), 'durable deletion target progress must refresh the parent deletion job lease');
assert(migration.includes('touch_customer_deletion_job_from_target'), 'deletion lease heartbeat trigger function must remain part of the schema');

console.log('automation reliability audit smoke: ok');
