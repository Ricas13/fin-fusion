'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const expiry = require('../src/entitlements/subscription-expiry');
const notificationTemplates = require('../src/integrations/notification-templates');
const { renderProfessionalEmail, eventLabel } = require('../src/integrations/email-template');

const expirySource = read('src/entitlements/subscription-expiry.js');
const jobs = read('src/automation/jobs.js');
const lifecycleNotifications = read('src/automation/notification-lifecycle.js');
const retirementMigration = read('db/migrations/037_notification_catalogue_runtime.sql');
const provisioning = read('src/jellyfin/provisioning.js');
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
assert(expirySource.includes('customer_entitlement_overrides')&&expirySource.includes('o.permanent_access=TRUE AND o.revoked_at IS NULL'), 'active Permanent Access must suppress expiry warnings for its pinned subscription');
assert(provisioning.includes('async function notifyExpiringSubscriptions(){return subscriptionExpiry.notifyExpiringSubscriptions()}'), 'subscription-expiry ownership must remain behind the provisioning facade');
assert(jobs.includes('const{expireSubscriptionsAndReconcile,notifyExpiringSubscriptions}=require(\'../jellyfin/provisioning\')'), 'automation must consume expiry behavior through the canonical provisioning facade');
assert(jobs.includes('const warnings=await notifyExpiringSubscriptions()'), 'the existing entitlement automation must generate expiry warnings');
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
// state. The automation worker discovers the job automatically from jobs.names().
assert(jobs.includes("const notificationLifecycle=require('./notification-lifecycle');"), 'notification lifecycle reconciler must be registered');
assert(jobs.includes('async notification_lifecycle(){return notificationLifecycle.run()}'), 'notification lifecycle automation job is missing');
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
require('./notification-catalogue-producer-audit');
