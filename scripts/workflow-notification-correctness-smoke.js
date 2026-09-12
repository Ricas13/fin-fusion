'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const expiry = require('../src/entitlements/subscription-expiry');
const expiryPolicy = require('../src/integrations/notification-expiry-policy');
const notificationTemplates = require('../src/integrations/notification-templates');
const { renderProfessionalEmail, eventLabel } = require('../src/integrations/email-template');

const expirySource = read('src/entitlements/subscription-expiry.js');
const jobs = read('src/automation/jobs.js');
const lifecycleNotifications = read('src/automation/notification-lifecycle.js');
const retirementMigration = read('db/migrations/037_notification_catalogue_runtime.sql');
const provisioning = read('src/jellyfin/provisioning.js');
const resilientProvisioning = read('src/jellyfin/resilient-provisioning.js');
const emailOutbox = read('src/integrations/email-outbox.js');
const secondaryOutbox = read('src/integrations/notification-outbox.js');

// Expiry reminders are for access that is genuinely scheduled to end: prepaid
// periods and recurring subscriptions whose renewal has been cancelled. Healthy
// active recurring subscriptions and trials must not receive expiry warnings.
assert.strictEqual(expiry.recurringAutoRenewal({ status: 'active', source: 'stripe', billing_mode: 'subscription', provider_subscription_id: 'sub_123' }), true);
assert.strictEqual(expiry.recurringAutoRenewal({ status: 'active', source: 'paypal', billing_mode: 'subscription', provider_subscription_id: 'I-ABC123' }), true);
assert.strictEqual(expiry.recurringAutoRenewal({ status: 'active', source: 'stripe', billing_mode: 'subscription', provider_subscription_id: 'sub_123', cancel_at_period_end: true }), false);
assert.strictEqual(expiry.recurringAutoRenewal({ status: 'cancelled', source: 'stripe', billing_mode: 'subscription', provider_subscription_id: 'sub_123' }), false);
assert.strictEqual(expiry.recurringAutoRenewal({ status: 'active', source: 'service_credit', billing_mode: 'payment', provider_subscription_id: null }), false);
assert(expiry.DEFAULT_WARNING_DAYS >= 1 && expiry.DEFAULT_WARNING_DAYS <= 30, 'expiry warning window must stay bounded');
assert.deepStrictEqual(expiryPolicy.DEFAULT_POLICY.milestones, [3, 0], 'default expiry cadence must cover three days and the final 24 hours only');
assert.deepStrictEqual(expiryPolicy.normalizeMilestones([1, '7', 3, 7, 0, 31, -1]), [3, 0], 'retired 7-day/1-day milestones must be discarded');
assert.deepStrictEqual(expiryPolicy.normalizePolicy({ milestones: [7, 1] }).milestones, [3, 0], 'legacy unsupported-only policies must safely fall back to the new default cadence');

const milestoneNow = new Date('2026-09-01T12:00:00Z');
const afterHours = hours => new Date(milestoneNow.getTime() + hours * 60 * 60 * 1000);
assert.strictEqual(expiry.selectExpiryMilestone(afterHours(7 * 24 + 12), [7, 3, 1, 0], milestoneNow), null, 'retired seven-day milestone must not be selectable');
assert.strictEqual(expiry.selectExpiryMilestone(afterHours(3 * 24 + 12), [3, 0], milestoneNow), null, 'three-day reminder must not fire early in the 72-to-96-hour window');
assert.strictEqual(expiry.selectExpiryMilestone(afterHours(3 * 24), [3, 0], milestoneNow), 3, 'three-day reminder must begin at 72 hours remaining');
assert.strictEqual(expiry.selectExpiryMilestone(afterHours(2 * 24 + 12), [3, 0], milestoneNow), 3, 'three-day reminder window must cover 48-to-72 hours remaining');
assert.strictEqual(expiry.selectExpiryMilestone(afterHours(2 * 24), [3, 0], milestoneNow), null, 'the 48-hour boundary must not create an extra reminder');
assert.strictEqual(expiry.selectExpiryMilestone(afterHours(1 * 24 + 12), [3, 0], milestoneNow), null, '24-to-48-hours remaining must not create a duplicate one-day warning');
assert.strictEqual(expiry.selectExpiryMilestone(afterHours(24), [3, 0], milestoneNow), 0, 'the final-24-hours reminder must begin exactly at 24 hours');
assert.strictEqual(expiry.selectExpiryMilestone(afterHours(12), [3, 0], milestoneNow), 0, 'final 24 hours must map to the zero-day milestone');
assert.strictEqual(expiry.selectExpiryMilestone(milestoneNow, [3, 0], milestoneNow), null, 'already expired access must not receive an expiry reminder');
const expiryAt = '2026-09-04T12:00:00.000Z';
assert.strictEqual(
    expiry.expiryDedupeKey({ subscriptionId: 'sub-row-1', accessExpiresAt: expiryAt, milestone: 3 }),
    'subscription-expiring:sub-row-1:2026-09-04T12:00:00.000Z:3',
    'expiry dedupe must include subscription, period end and milestone exactly'
);
assert.notStrictEqual(
    expiry.expiryDedupeKey({ subscriptionId: 'sub-row-1', accessExpiresAt: expiryAt, milestone: 3 }),
    expiry.expiryDedupeKey({ subscriptionId: 'sub-row-1', accessExpiresAt: expiryAt, milestone: 0 }),
    'one expiry milestone must never swallow another'
);

// Warning discovery must not repeat a fixed first page forever. Dedupe happens
// at the durable outbox; the scan itself deliberately has no LIMIT starvation.
assert(expirySource.includes("eventType: 'subscription.expiring'"), 'subscription expiry must produce the configured notification event');
assert(!expirySource.includes('SUBSCRIPTION_EXPIRY_WARNING_DAYS'), 'expiry cadence must no longer be owned by one environment warning-day value');
assert(!/async function expiringSubscriptions[\s\S]*?LIMIT\s+\$\d/i.test(expirySource), 'expiry warning discovery must not use a fixed SQL LIMIT');
assert(expirySource.includes("COALESCE(p.is_free_tier,FALSE)=FALSE"), 'non-expiring Free Access must not receive expiry warnings');
assert(expirySource.includes("LOWER(COALESCE(s.billing_interval_snapshot,p.billing_interval,''))<>'trial'"), 'trials must not receive normal subscription expiry reminders');
assert(expirySource.includes("s.billing_mode='payment'"), 'prepaid payment-mode access must remain eligible for expiry reminders');
assert(expirySource.includes("s.billing_mode='subscription'\n              AND s.source IN ('stripe','paypal')"), 'only provider-backed recurring subscriptions may use cancellation expiry reminders');
assert(expirySource.includes("s.status='cancelled' OR COALESCE(s.cancel_at_period_end,FALSE)=TRUE"), 'cancelled or cancel-at-period-end recurring subscriptions must remain eligible');
assert(!/s\.billing_mode='payment'\s+OR\s+s\.status='cancelled'/.test(expirySource), 'cancelled manual/non-recurring rows must not bypass the billing-mode eligibility boundary');
assert(expirySource.includes('customer_entitlement_overrides')&&expirySource.includes('o.permanent_access=TRUE AND o.revoked_at IS NULL'), 'active Permanent Access must suppress expiry warnings for its pinned subscription');
assert(expirySource.includes('subscription_admin_present'), 'an admin-granted goodwill/authority present state must also suppress expiry warnings, since that access will not actually lapse');
assert(/async function notifyExpiringSubscriptions\(\)\s*\{\s*return subscriptionExpiry\.notifyExpiringSubscriptions\(\);\s*\}/.test(provisioning), 'subscription-expiry notification behavior must remain behind the provisioning facade');
assert(/async function expireSubscriptionsAndReconcile\(\)\s*\{\s*return subscriptionExpiry\.expireAndReconcile\(\{\s*reconcileCustomer\b/.test(resilientProvisioning), 'resilient provisioning must own lane-aware expiry reconciliation');
assert(jobs.includes("const{expireSubscriptionsAndReconcile}=require('../jellyfin/resilient-provisioning');"), 'automation must consume lane-aware expiry reconciliation through resilient provisioning');
assert(jobs.includes("const{notifyExpiringSubscriptions}=require('../jellyfin/provisioning');"), 'automation must consume expiry notifications through the provisioning compatibility facade');
assert(jobs.includes('warnings=await notifyExpiringSubscriptions()'), 'the existing entitlement automation must generate expiry warnings');
assert(jobs.indexOf('notifyExpiringSubscriptions()') < jobs.indexOf('expireSubscriptionsAndReconcile()'), 'warnings must be checked before due subscriptions are expired');

// Transactional rendering stays code-owned. The catalogue must preserve richer
// facts for existing producers while chat remains short and email CTAs are
// explicit account actions rather than whichever URL happened to appear first.
const jellyfin = notificationTemplates.renderNotification({
    eventType: 'customer.service.provisioned',
    subject: 'Your CAPTAiNFiN Jellyfin access is ready',
    text: 'Your Jellyfin access has been created. Open the server at https://media.example.test and sign in as maria. Sign in to your portal first and choose your Jellyfin password.',
    payload: { accountUrl: 'https://captainfin.example.test/account' }
});
assert.strictEqual(jellyfin.discord, '✅ Your Jellyfin access is ready — https://media.example.test · user maria · https://captainfin.example.test/account', 'Jellyfin chat must expose the exact service-ready recovery facts');
assert(jellyfin.email.facts.some(row => row.label === 'Server' && row.value === 'https://media.example.test'), 'Jellyfin email must expose the exact server fact');
assert(jellyfin.email.facts.some(row => row.label === 'Username' && row.value === 'maria'), 'Jellyfin email must expose the username fact');

const stremio = notificationTemplates.renderNotification({
    eventType: 'customer.service.provisioned',
    subject: 'Your CAPTAiNFiN Stremio access is ready',
    text: 'Your Stremio access has been created.',
    payload: { service: 'Stremio', accountUrl: 'https://captainfin.example.test/account' }
});
assert.strictEqual(stremio.email.actionLabel, 'Open Stremio setup', 'Stremio email must name the setup action precisely');
assert.strictEqual(stremio.email.actionUrl, 'https://captainfin.example.test/account#stremio-access', 'Stremio email must target the canonical Account Home Stremio section');
assert.strictEqual(stremio.discord, '✅ Your Stremio access is ready — https://captainfin.example.test/account#stremio-access', 'Stremio chat must target the canonical Account Home Stremio section');

const expiryNotice = notificationTemplates.renderNotification({
    eventType: 'subscription.expiring',
    subject: 'Premium expires soon',
    text: 'Legacy expiry copy',
    payload: { planName: 'Premium', expiresOn: '2026-09-01T00:00:00Z', autoRenewal: false, accountUrl: 'https://captainfin.example.test/account' }
});
assert(expiryNotice.telegram.includes('Premium expires 1 Sept 2026'), 'expiry chat must contain plan and date');
assert(expiryNotice.telegram.includes('Auto-renew is off.'), 'expiry chat must state the renewal state');
assert(expiryNotice.email.facts.some(row => row.label === 'Next step'), 'expiry email must contain a next-step fact');

const failedPayment = notificationTemplates.renderNotification({
    eventType: 'payment.failed',
    subject: 'Payment failed',
    text: 'Your Stripe renewal payment could not be confirmed (GBP 9.99).',
    payload: { planName: 'Premium', accountUrl: 'https://captainfin.example.test/account' }
});
assert(failedPayment.discord.includes('£9.99'), 'payment chat must carry amount and currency');
assert(failedPayment.discord.includes('Premium'), 'payment chat must carry the plan');
assert(failedPayment.email.facts.some(row => row.label === 'Amount' && row.value.includes('9.99')), 'payment email must expose the amount fact');

const removedAdmin = notificationTemplates.renderNotification({
    eventType: 'customer.access.removed',
    subject: 'Access removed',
    text: 'Fallback copy',
    audience: 'admin',
    payload: { customerName: 'Maria', planName: 'Free Server', service: 'Jellyfin', serverName: 'UK-4K-1', reason: 'inactivity (14 days)', adminUrl: 'https://captainfin.example.test/admin/users/c-1' }
});
assert.strictEqual(removedAdmin.discord, 'Maria removed from UK-4K-1 — inactivity (14 days) (Free Server). https://captainfin.example.test/admin/users/c-1', 'admin access chat must be one precise recovery line');

const emailHtml = renderProfessionalEmail({
    eventType: 'subscription.expiring',
    subject: 'Premium expires soon',
    text: 'Reference: https://unrelated.example.test/path',
    payload: { planName: 'Premium', expiresOn: '2026-09-01T00:00:00Z', accountUrl: 'https://captainfin.example.test/account' },
    nextStep: 'Review renewal options',
    siteName: 'CAPTAiNFiN',
    publicBaseUrl: 'https://captainfin.example.test'
});
assert(emailHtml.includes('href="https://captainfin.example.test/account"'), 'transactional CTA must use the account URL');
assert(!emailHtml.includes('href="https://unrelated.example.test/path"'), 'transactional CTA must never use the first random body URL');
assert(emailHtml.includes('>Plan</td>') && emailHtml.includes('>Date</td>') && emailHtml.includes('>Next step</td>'), 'structured email must render the fact table');
assert.strictEqual(eventLabel('customer.claim.completed'), 'Claim completed');
assert.strictEqual(eventLabel('some.future.event'), 'Some · Future · Event', 'unknown real events must still have a useful label');

// Every other durable lifecycle notification is reconciled from committed DB
// state. Failed dispatch windows must retain their previous cursor so a transient
// enqueue/configuration failure cannot permanently skip lifecycle events.
assert(jobs.includes("const notificationLifecycle=require('./notification-lifecycle');"), 'notification lifecycle reconciler must be registered');
assert(jobs.includes('async notification_lifecycle(){return notificationLifecycleSafeRun()}'), 'notification lifecycle automation must use the failure-aware checkpoint owner');
assert(jobs.includes('const checkpoint=await notificationLifecycle.loadState(new Date())'), 'notification lifecycle must capture its prior durable checkpoint before dispatch');
assert(jobs.includes('if(Number(result?.failed||0)>0)'), 'notification lifecycle must detect failed dispatch passes before accepting the new cursor');
assert(jobs.includes('cursorRetained:true'), 'failed lifecycle passes must report that the previous cursor was retained');
assert(jobs.includes('cursor:checkpoint.cursor.toISOString()'), 'failed lifecycle passes must restore the previous cursor rather than advancing past undelivered events');
assert(lifecycleNotifications.includes("const STATE_KEY = 'notification_lifecycle_cursor_v1'"), 'notification lifecycle must persist a cursor');
assert(lifecycleNotifications.includes("event_type='invoice.paid'"), 'Stripe paid invoices must produce renewal payment receipts');
assert(lifecycleNotifications.includes("a.action='payment.subscription.activate'"), 'committed payment activations must produce payment receipts');
assert(lifecycleNotifications.includes("action='customer.inactivity.disable_jellyfin'"), 'inactivity notifications must come from durable enforcement audit rows');
assert(lifecycleNotifications.includes("currentStatus === 'offline' && prior?.status !== 'offline'"), 'server offline notifications must be transition based');
assert(lifecycleNotifications.includes("dedupeKey: `provisioning-failed:${row.customer_id}:${dateKey(row.last_success_at)}`"), 'provisioning failures must dedupe by failure episode');
assert(lifecycleNotifications.includes("dedupeKey: `automation-error:${row.job_key}:${dateKey(row.last_success_at)}`"), 'automation failures must dedupe by failure episode');

for (const eventType of [
    'automation.error',
    'customer.plan_change.applied',
    'customer.plan_change.failed',
    'customer.plan_change.scheduled',
    'customer.service.expired',
    'customer.service.inactive',
    'payment.chargeback',
    'payment.disputed',
    'payment.failed',
    'payment.received',
    'payment.refunded',
    'payment.renewal_failed',
    'provisioning.failed',
    'server.offline',
    'subscription.activated',
    'subscription.cancelled'
]) assert(lifecycleNotifications.includes(`eventType: '${eventType}'`), `missing durable producer for ${eventType}`);

for (const retired of [
    'account.announcement',
    'attention.created',
    'customer.created',
    'request.created',
    'security.alert',
    'customer.subscription.cancelled',
    'customer.subscription.requested',
    'customer.trial.requested',
    'customer.stremio.requested'
]) assert(retirementMigration.includes(`'${retired}'`), `retired notification event is missing from migration: ${retired}`);
assert(retirementMigration.includes("SET event_scope='customer'"), 'payment.failed must be customer scoped to avoid duplicate admin renewal alerts');
assert(retirementMigration.includes("WHERE event_type='payment.failed'"), 'payment.failed scope migration is missing');

// Email and secondary messaging share one physical outbox but have independent
// workers. A stale `sending` row is ambiguous: the external provider may already
// have accepted it before the worker died. Blindly reclaiming that row can send a
// duplicate customer/admin message. Quarantine it as dead/uncertain instead and
// require an explicit operator retry.
assert(emailOutbox.includes("INSERT INTO notification_outbox(channel,message_type,recipient_email"), 'email enqueue must identify its channel explicitly');
assert(emailOutbox.includes("VALUES('email',$1,$2,$3,$4,'pending',NOW())"), 'email rows must be persisted with channel=email');
assert(emailOutbox.includes("WHERE channel='email' AND status='sending'"), 'email worker must identify stale in-flight email rows for quarantine');
assert(emailOutbox.includes("SET status='dead',last_error=$1"), 'ambiguous email delivery must be quarantined instead of automatically resent');
assert(emailOutbox.includes("status IN ('pending','failed')"), 'email claims must be limited to confirmed retryable states');
assert(!/SELECT id FROM notification_outbox[\s\S]*?status='sending'[\s\S]*?FOR UPDATE SKIP LOCKED/.test(emailOutbox), 'email claim must never reclaim an ambiguous sending row');
assert(emailOutbox.includes("WHERE id=$1 AND channel='email'"), 'email row mutations must remain channel-scoped');
assert(emailOutbox.includes("FROM notification_outbox WHERE channel='email' ORDER BY created_at DESC"), 'email delivery history must remain isolated to email rows');
assert(emailOutbox.includes("WHERE channel='email'"), 'email aggregate queries must remain channel-scoped');
assert(emailOutbox.includes('const STALE_SENDING_MINUTES = 15'), 'email sending ambiguity must have a bounded stale threshold');
assert(emailOutbox.includes('UNCERTAIN_DELIVERY_ERROR'), 'email uncertain delivery must retain an operator-readable reason');

assert(secondaryOutbox.includes("WHERE channel<>'email' AND status='sending'"), 'secondary worker must identify stale in-flight rows while remaining isolated from email');
assert(secondaryOutbox.includes("SET status='dead',last_error=$1"), 'ambiguous secondary delivery must be quarantined instead of automatically resent');
assert(secondaryOutbox.includes("WHERE channel<>'email' AND status IN('pending','failed')"), 'secondary claims must be limited to confirmed retryable states');
assert(!/SELECT id,channel,message_type[\s\S]*?status='sending'[\s\S]*?FOR UPDATE SKIP LOCKED/.test(secondaryOutbox), 'secondary claim must never reclaim an ambiguous sending row');
assert(secondaryOutbox.includes('make_interval(mins=>$2)'), 'secondary notification quarantine must have an explicit stale timeout');
assert(secondaryOutbox.includes("WHERE channel<>'email' ORDER BY created_at DESC"), 'secondary delivery history must remain isolated from email rows');
assert(secondaryOutbox.includes('UNCERTAIN_DELIVERY_ERROR'), 'secondary uncertain delivery must retain an operator-readable reason');

console.log('workflow notification correctness smoke: ok');
require('./notification-catalogue-producer-audit');