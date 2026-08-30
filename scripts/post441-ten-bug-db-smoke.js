'use strict';
require('dotenv').config();
const assert = require('assert');
const { query, getPool } = require('../src/db');
const lifecycle = require('../src/payments/lifecycle');
const incidents = require('../src/payments/incidents');
const accessHolds = require('../src/entitlements/access-holds');
const providerOps = require('../src/payments/provider-operations');
const referrals = require('../src/referrals');
const credits = require('../src/affiliate-credits');

async function createCustomer(label, suffix) {
  return (await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`, [label, `${label}-${suffix}@example.invalid`])).rows[0];
}

async function paymentEventCooldown(suffix) {
  const eventId = `evt_retry_${suffix}`;
  const row = await lifecycle.beginPaymentEvent({ provider:'stripe', eventId, eventType:'test.retry', payload:{ id:eventId } });
  assert(row, 'payment event must be claimed initially');
  await lifecycle.finishPaymentEvent(row, new Error('transient provider failure'));
  const failed = (await query(`SELECT processing_started_at,processing_token,processing_error FROM payment_events WHERE provider='stripe' AND provider_event_id=$1`, [eventId])).rows[0];
  assert(failed.processing_started_at, 'failed payment event must keep a retry timestamp');
  assert.equal(failed.processing_token, null);
  assert.match(failed.processing_error, /transient provider failure/);

  const immediate = await lifecycle.claimRetryablePaymentEvents({ limit:100 });
  assert(!immediate.some(item => String(item.provider_event_id) === eventId), 'freshly failed event must respect retry cooldown');

  await query(`UPDATE payment_events SET processing_started_at=NOW()-INTERVAL '6 minutes' WHERE provider='stripe' AND provider_event_id=$1`, [eventId]);
  const retried = await lifecycle.claimRetryablePaymentEvents({ limit:100 });
  const claimed = retried.find(item => String(item.provider_event_id) === eventId);
  assert(claimed, 'failed event must become claimable after retry cooldown');
  await lifecycle.finishPaymentEvent(claimed);
}

async function incidentReplay(customer, suffix) {
  const eventId = `evt_dispute_${suffix}`;
  const caseId = `dp_${suffix}`;
  const first = await incidents.record({ provider:'stripe', eventId, caseId, kind:'dispute', status:'open', identity:{ scope:'direct', customerId:customer.id }, providerSubscriptionId:`sub_${suffix}` });
  assert.equal(first.duplicate, false);
  assert((await accessHolds.activeHolds(customer.id)).some(h => h.hold_type === 'payment_risk'), 'initial dispute must apply payment-risk hold');

  await accessHolds.releaseHold({ customerId:customer.id, type:'payment_risk', sourceKey:incidents.holdSource('stripe', caseId) });
  assert(!(await accessHolds.activeHolds(customer.id)).some(h => h.hold_type === 'payment_risk'), 'test fixture must simulate missing incident side effect');

  const replay = await incidents.record({ provider:'stripe', eventId, caseId, kind:'dispute', status:'open', identity:{ scope:'direct', customerId:customer.id }, providerSubscriptionId:`sub_${suffix}` });
  assert.equal(replay.duplicate, true);
  assert((await accessHolds.activeHolds(customer.id)).some(h => h.hold_type === 'payment_risk'), 'duplicate incident replay must restore missing payment-risk hold');

  // A resolved incident that is reopened must restore its original suspensive side effect.
  await accessHolds.releaseHold({ customerId:customer.id, type:'payment_risk', sourceKey:incidents.holdSource('stripe', caseId) });
  await query(`UPDATE payment_incidents SET incident_status='resolved',resolved_at=NOW() WHERE id=$1`, [first.incident.id]);
  await incidents.reopen(first.incident.id, null);
  assert((await accessHolds.activeHolds(customer.id)).some(h => h.hold_type === 'payment_risk' && h.source_key === incidents.holdSource('stripe', caseId)), 'reopening a suspensive incident must reapply the payment-risk hold');

  const unresolvedCustomer = await createCustomer('incident-upgrade', suffix);
  const unresolvedEvent = `evt_unresolved_${suffix}`;
  const unresolvedCase = `dp_unresolved_${suffix}`;
  const unresolved = await incidents.record({ provider:'stripe', eventId:unresolvedEvent, caseId:unresolvedCase, kind:'dispute', status:'open', identity:{ scope:'unresolved', customerId:null }, providerSubscriptionId:`sub_unresolved_${suffix}` });
  assert.equal(unresolved.incident.scope, 'unresolved');
  const upgraded = await incidents.record({ provider:'stripe', eventId:unresolvedEvent, caseId:unresolvedCase, kind:'dispute', status:'open', identity:{ scope:'direct', customerId:unresolvedCustomer.id }, providerSubscriptionId:`sub_unresolved_${suffix}` });
  assert.equal(upgraded.duplicate, true);
  const stored = (await query('SELECT scope,customer_id FROM payment_incidents WHERE id=$1', [upgraded.incident.id])).rows[0];
  assert.equal(stored.scope, 'direct', 'incident replay must upgrade unresolved identity');
  assert.equal(String(stored.customer_id), String(unresolvedCustomer.id));
  assert((await accessHolds.activeHolds(unresolvedCustomer.id)).some(h => h.hold_type === 'payment_risk'), 'identity upgrade must drive the pending suspension');
}

async function providerOperationFence(customer, suffix) {
  const op = await providerOps.begin({ provider:'stripe', scope:'customer', ownerId:customer.id, operationType:'test_fence', localReference:`test-${suffix}`, idempotencyKey:`test-fence-${suffix}`, request:{ test:true } });
  await query('UPDATE provider_operations SET next_attempt_at=NOW() WHERE id=$1', [op.id]);
  const firstClaims = await providerOps.claimRecoverable({ limit:100 });
  const first = firstClaims.find(item => String(item.id) === String(op.id));
  assert(first, 'first provider-operation claim must be acquired');

  await query('UPDATE provider_operations SET next_attempt_at=NOW() WHERE id=$1', [op.id]);
  const secondClaims = await providerOps.claimRecoverable({ limit:100 });
  const second = secondClaims.find(item => String(item.id) === String(op.id));
  assert(second, 'second provider-operation claim must supersede the stale worker');
  assert(Number(second.attempt_count) > Number(first.attempt_count));

  let staleError = null;
  try {
    await providerOps.withRecoveryClaim(first, () => providerOps.markManual(first.id, new Error('stale worker must not win')));
  } catch (error) { staleError = error; }
  assert(staleError?.providerOperationLeaseLost, 'stale worker must be fenced by attempt generation');
  const afterStale = await providerOps.get(op.id);
  assert.notEqual(afterStale.state, 'failed', 'stale worker must not overwrite newer claim state');

  await providerOps.withRecoveryClaim(second, () => providerOps.markManual(second.id, new Error('current worker owns the lease')));
  const final = await providerOps.get(op.id);
  assert.equal(final.state, 'failed');
  assert.equal(final.manual_review_required, true);
}

async function affiliateFirstHistoricalPurchase(suffix) {
  await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('affiliate_program',$1::jsonb)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`, [JSON.stringify({ enabled:true,rewardPercent:20,qualificationDelayDays:0,refundWindowDays:0 })]);
  const referrer = await createCustomer('historical-referrer', suffix);
  const friend = await createCustomer('historical-friend', suffix);
  const plan = (await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class)
    VALUES($1,$1,'jellyfin','direct','month',30,1000,'GBP',100,TRUE,TRUE,1,'premium') RETURNING *`, [`historical-plan-${suffix}`])).rows[0];
  await credits.enroll(referrer.id);
  const code = (await query('SELECT code FROM referral_codes WHERE customer_id=$1', [referrer.id])).rows[0].code;
  await referrals.attributeReferral(friend.id, code);

  const first = (await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,price_minor_snapshot,currency_snapshot,service_type_snapshot,commercial_snapshot,superseded_by)
    VALUES($1,$2,'expired','stripe',$3,NOW()-INTERVAL '90 days',NOW()-INTERVAL '60 days',1000,'GBP','jellyfin',$4::jsonb,NULL) RETURNING *`, [friend.id,plan.id,`pi_first_${suffix}`,JSON.stringify({ discountedMinor:1000,currency:'GBP',checkoutMode:'payment' })])).rows[0];
  await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,price_minor_snapshot,currency_snapshot,service_type_snapshot,commercial_snapshot)
    VALUES($1,$2,'active','stripe',$3,NOW()-INTERVAL '1 day',NOW()+INTERVAL '29 days',2500,'GBP','jellyfin',$4::jsonb)`, [friend.id,plan.id,`pi_second_${suffix}`,JSON.stringify({ discountedMinor:2500,currency:'GBP',checkoutMode:'payment' })]);

  const reward = await referrals.rewardIfQualifying(friend.id);
  assert.equal(reward?.rewarded, true);
  assert.equal(reward.amountMinor, 200, 'reward must remain based on the £10 first purchase, not the later £25 purchase');
  const earned = (await query(`SELECT qualifying_subscription_id FROM affiliate_credit_ledger WHERE referred_customer_id=$1 AND entry_type='earned' ORDER BY created_at LIMIT 1`, [friend.id])).rows[0];
  assert.equal(String(earned.qualifying_subscription_id), String(first.id), 'expired historical first paid purchase must remain the affiliate basis');
}

async function renewalReservationBalance(suffix) {
  const customer = await createCustomer('renewal-balance', suffix);
  await query(`INSERT INTO affiliate_profiles(customer_id,active) VALUES($1,TRUE)`, [customer.id]);
  await query(`INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,reference_id,note)
    VALUES($1,'GBP',1000,'adjustment','available',$2,'test grant')`, [customer.id, `renewal-balance-grant-${suffix}`]);
  const plan = (await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class)
    VALUES($1,$1,'jellyfin','direct','month',30,1000,'GBP',100,TRUE,TRUE,1,'premium') RETURNING *`, [`renewal-balance-plan-${suffix}`])).rows[0];
  const sub = (await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,price_minor_snapshot,currency_snapshot,service_type_snapshot)
    VALUES($1,$2,'active','stripe',$3,NOW(),NOW()+INTERVAL '30 days',1000,'GBP','jellyfin') RETURNING id`, [customer.id, plan.id, `sub_renewal_balance_${suffix}`])).rows[0];
  await query(`INSERT INTO affiliate_credit_renewal_reservations(customer_id,subscription_id,provider,provider_invoice_id,currency,amount_minor,state,provider_adjustment_id)
    VALUES($1,$2,'stripe',$3,'GBP',300,'provider_applied',$4)`, [customer.id, sub.id, `in_balance_${suffix}`, `ii_balance_${suffix}`]);
  const balance = (await credits.balances(customer.id)).find(row => row.currency === 'GBP');
  assert.equal(balance.available_minor, 700, 'displayed spendable balance must subtract provider-applied renewal credit');
}

async function main() {
  const suffix = Date.now().toString(36);
  const customer = await createCustomer('post441-bugs', suffix);
  await paymentEventCooldown(suffix);
  await incidentReplay(customer, suffix);
  await providerOperationFence(customer, suffix);
  await affiliateFirstHistoricalPurchase(suffix);
  await renewalReservationBalance(suffix);
  console.log('post-441 ten-bug DB smoke: ok');
}

main().then(() => getPool().end()).catch(async error => { console.error(error.stack || error); try { await getPool().end(); } catch (_) {} process.exit(1); });
