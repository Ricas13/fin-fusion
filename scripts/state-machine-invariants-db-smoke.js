'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const primitives = require('../src/payments/lifecycle-primitives');
const termination = require('../src/payments/subscription-termination');
const subscriptionState = require('../src/entitlements/subscription-state');
const accessHolds = require('../src/entitlements/access-holds');
const cleanupReturn = require('../src/entitlements/jellyfin-cleanup-return');
const discordRoles = require('../src/integrations/discord-roles');

const suffix = crypto.randomBytes(5).toString('hex');
const created = { customers: [], plans: [] };

async function customer(label) {
  const row = await query(
    `INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`,
    [`State machine ${label} ${suffix}`, `state-machine-${label}-${suffix}@example.invalid`]
  );
  created.customers.push(row.rows[0].id);
  return row.rows[0].id;
}

async function plan(label, options = {}) {
  const row = await query(`
    INSERT INTO plans(
      code,name,audience,billing_interval,duration_days,price_minor,currency,streams,
      server_class,service_type,is_free_tier,is_addon,active,visible,discord_role_id
    ) VALUES($1,$2,'direct',$3,$4,$5,'GBP',1,'premium',$6,$7,$8,TRUE,TRUE,$9)
    RETURNING id
  `, [
    `state-machine-${label}-${suffix}`,
    `State machine ${label}`,
    options.billingInterval || 'monthly',
    options.durationDays || 30,
    options.priceMinor == null ? 999 : Number(options.priceMinor),
    options.serviceType || 'jellyfin',
    Boolean(options.free),
    Boolean(options.addon),
    options.discordRoleId || null
  ]);
  created.plans.push(row.rows[0].id);
  return row.rows[0].id;
}

async function fullRefundIncident(customerId, provider, providerRef, label) {
  return (await query(`
    INSERT INTO payment_incidents(
      provider,provider_event_id,provider_case_id,incident_type,incident_status,scope,
      customer_id,provider_subscription_id,access_action,metadata
    ) VALUES($1,$2,$3,'refund','recorded','direct',$4,$5,'preserve',$6::jsonb)
    RETURNING *
  `, [provider, `state-machine-refund-${label}-${suffix}`, `case-${label}-${suffix}`, customerId, providerRef, JSON.stringify({ fullRefund: true, test: true })])).rows[0];
}

async function activate({ customerId, planId, provider = 'stripe', providerRef, mode = 'payment' }) {
  return primitives.activatePurchase({
    customerId,
    planId,
    provider,
    providerSubscriptionId: providerRef,
    providerStatus: provider === 'paypal' ? 'ACTIVE' : 'active',
    commercialSnapshot: {
      kind: 'direct_plan',
      provider,
      planId,
      planCode: `snapshot-${suffix}`,
      planName: 'State machine snapshot',
      priceMinor: 999,
      discountedMinor: 999,
      currency: 'GBP',
      billingInterval: 'monthly',
      durationDays: 30,
      checkoutMode: mode,
      streams: 1,
      serverClass: 'premium'
    }
  });
}

async function assertNoEffective(customerId, message) {
  const effective = await subscriptionState.effectiveSubscription(customerId, { includeBlocked: true });
  assert.strictEqual(effective, null, message);
}

async function testRefundBeforeActivation() {
  const customerId = await customer('refund-before');
  const planId = await plan('refund-before');
  const ref = `pi_refund_before_${suffix}`;
  await fullRefundIncident(customerId, 'stripe', ref, 'before');

  const row = await activate({ customerId, planId, providerRef: ref });
  assert.strictEqual(row.status, 'cancelled', 'refund-before-activation must create only a terminal ledger row');
  assert(row.refund_terminated_at, 'refund-before-activation must materialize refund_terminated_at');
  assert(new Date(row.current_period_end).getTime() <= Date.now() + 1000, 'refunded settlement must not keep future paid-through time');
  await assertNoEffective(customerId, 'refund-before-activation must never grant effective access');
}

async function testRefundThenStaleActivationReplay() {
  const customerId = await customer('refund-replay');
  const planId = await plan('refund-replay');
  const ref = `pi_refund_replay_${suffix}`;

  const first = await activate({ customerId, planId, providerRef: ref });
  assert.strictEqual(first.status, 'active', 'fixture activation should begin live');
  await fullRefundIncident(customerId, 'stripe', ref, 'replay');
  const ended = await termination.terminateForRefund(first.id, customerId, { reason: 'state-machine regression full refund' });
  assert.strictEqual(ended.changed, true, 'fixture refund should terminate the live subscription');
  await assertNoEffective(customerId, 'refund should remove effective access before stale retry');

  const replay = await activate({ customerId, planId, providerRef: ref });
  assert.strictEqual(replay.id, first.id, 'stale checkout replay should keep the same provider subscription row');
  assert.strictEqual(replay.status, 'cancelled', 'stale checkout replay must not reactivate a refunded row');
  assert(replay.refund_terminated_at, 'stale checkout replay must retain refund termination evidence');
  await assertNoEffective(customerId, 'stale checkout replay after refund must leave access absent');

  // Direct future writers are also constrained: attempting to reactivate the row
  // is coerced back to terminal state by the DB trigger.
  const forced = (await query(`
    UPDATE subscriptions
    SET status='active',current_period_end=NOW()+INTERVAL '90 days',service_extension_days=30
    WHERE id=$1 RETURNING status,current_period_end,service_extension_days,refund_terminated_at
  `, [first.id])).rows[0];
  assert.strictEqual(forced.status, 'cancelled', 'DB boundary must prevent direct refund resurrection');
  assert.strictEqual(Number(forced.service_extension_days || 0), 0, 'DB boundary must clear extensions on refund-terminated rows');
  assert(new Date(forced.current_period_end).getTime() <= Date.now() + 1000, 'DB boundary must cap refund-terminated period end');
}

async function testConcurrentRecurringSettlement() {
  const customerId = await customer('recurring-race');
  const planId = await plan('recurring-race');
  const calls = [
    activate({ customerId, planId, provider: 'stripe', providerRef: `sub_race_a_${suffix}`, mode: 'subscription' }),
    activate({ customerId, planId, provider: 'paypal', providerRef: `I-RACE-B-${suffix.toUpperCase()}`, mode: 'subscription' })
  ];
  const settled = await Promise.allSettled(calls);
  const fulfilled = settled.filter(result => result.status === 'fulfilled');
  const rejected = settled.filter(result => result.status === 'rejected');
  assert.strictEqual(fulfilled.length, 1, `exactly one concurrent recurring settlement must win; got ${JSON.stringify(settled.map(x => x.status))}`);
  assert.strictEqual(rejected.length, 1, 'one overlapping recurring settlement must be rejected');
  assert(/recurring|service lane|already active/i.test(String(rejected[0].reason?.message || rejected[0].reason)), `unexpected recurring-race error: ${rejected[0].reason?.message}`);

  const live = await query(`
    SELECT id FROM subscriptions
    WHERE customer_id=$1 AND source IN('stripe','paypal') AND billing_mode='subscription'
      AND status IN('active','trialing','past_due','paused') AND current_period_end>NOW()
      AND superseded_by IS NULL
  `, [customerId]);
  assert.strictEqual(live.rowCount, 1, 'database must contain at most one live recurring contract for the service lane');
}

async function testEnableDoesNotUndoDestructiveAuthority() {
  const customerId = await customer('admin-holds');
  await accessHolds.addHold({ customerId, type: 'admin_disabled', sourceKey: 'admin', reason: 'disabled' });
  await accessHolds.addHold({ customerId, type: 'admin_hold', sourceKey: 'admin', reason: 'Administrative ban' });
  await accessHolds.addHold({ customerId, type: 'admin_hold', sourceKey: 'admin', reason: 'jellyfin_deleted' });

  const before = await accessHolds.activeHolds(customerId);
  assert(before.some(row => row.hold_type === 'administrative_ban'), 'ban must have its own hold type');
  assert(before.some(row => row.hold_type === 'jellyfin_identity_removed'), 'identity removal must have its own hold type');

  await accessHolds.releaseAllAdminHolds(customerId);
  const after = await accessHolds.activeHolds(customerId);
  assert(!after.some(row => row.hold_type === 'admin_disabled'), 'routine Enable should release ordinary admin-disabled state');
  assert(after.some(row => row.hold_type === 'administrative_ban'), 'routine Enable must not release a ban');
  assert(after.some(row => row.hold_type === 'jellyfin_identity_removed'), 'routine Enable must not release an identity-removal hold');
}

async function testDiscordRoleHistory() {
  const roleA = `10${String(Date.now()).slice(-16)}`.padEnd(18, '1').slice(0, 18);
  const roleB = `20${String(Date.now()).slice(-16)}`.padEnd(18, '2').slice(0, 18);
  const planId = await plan('discord-history', { discordRoleId: roleA });
  await query('UPDATE plans SET discord_role_id=$2,updated_at=NOW() WHERE id=$1', [planId, roleB]);

  const history = await query(`SELECT role_id,retired_at FROM discord_managed_role_history WHERE role_id=ANY($1::text[])`, [[roleA, roleB]]);
  const byRole = new Map(history.rows.map(row => [row.role_id, row]));
  assert(byRole.has(roleA), 'old Discord role must remain in durable managed-role history after remap');
  assert(byRole.get(roleA).retired_at, 'old Discord role should be marked retired after remap');
  assert(byRole.has(roleB), 'new Discord role must be recorded in managed-role history');
  assert.strictEqual(byRole.get(roleB).retired_at, null, 'current Discord role must not be marked retired');

  const managed = await discordRoles.managedRoleIds();
  assert(managed.has(roleA), 'old role must remain removable by future reconciliation');
  assert(managed.has(roleB), 'new role must be managed');
}

async function testFreeRestoreUsesInactivityHold() {
  const customerId = await customer('free-restore');
  const planId = await plan('free-restore', { free: true, priceMinor: 0, billingInterval: 'custom', serviceType: 'jellyfin' });
  await query(`
    INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,service_type_snapshot,billing_mode)
    VALUES($1,$2,'active','free_claim',NOW()-INTERVAL '1 day',NOW()+INTERVAL '3650 days','jellyfin','payment')
  `, [customerId, planId]);
  await accessHolds.addHold({
    customerId,
    type: 'inactivity_policy',
    sourceKey: `plan:${planId}`,
    reason: 'Free Server inactivity policy'
  });

  const lifecycleRows = await query(`SELECT id FROM jellyfin_account_lifecycle WHERE customer_id=$1`, [customerId]);
  assert.strictEqual(lifecycleRows.rowCount, 0, 'fixture must prove restore without the retired lifecycle ledger');
  const status = await cleanupReturn.returningCustomerStatus(customerId);
  assert.strictEqual(status.canRestoreDeletedFree, true, 'active inactivity hold + Free entitlement must make restore visible');
  assert.strictEqual(status.eligible, true, 'Free inactivity removal must be self-service restorable without retired ledger data');
}

async function cleanup() {
  for (const customerId of [...created.customers].reverse()) {
    await query('DELETE FROM payment_incidents WHERE customer_id=$1', [customerId]).catch(() => {});
    await query('DELETE FROM customer_access_holds WHERE customer_id=$1', [customerId]).catch(() => {});
    await query('DELETE FROM subscriptions WHERE customer_id=$1', [customerId]).catch(() => {});
    await query('DELETE FROM customers WHERE id=$1', [customerId]).catch(() => {});
  }
  for (const planId of [...created.plans].reverse()) {
    await query('DELETE FROM plans WHERE id=$1', [planId]).catch(() => {});
  }
}

(async () => {
  await testRefundBeforeActivation();
  await testRefundThenStaleActivationReplay();
  await testConcurrentRecurringSettlement();
  await testEnableDoesNotUndoDestructiveAuthority();
  await testDiscordRoleHistory();
  await testFreeRestoreUsesInactivityHold();
  console.log('state-machine invariants DB smoke: ok');
})().finally(async () => {
  await cleanup();
  await getPool().end();
}).catch(error => {
  console.error('state-machine invariants DB smoke failed:', error);
  process.exit(1);
});
