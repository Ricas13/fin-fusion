'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { query, transaction, getPool } = require('../src/db');
const intents = require('../src/payments/checkout-intents');
const creditReservations = require('../src/payments/service-credit-reservations');
const accounting = require('../src/payments/service-credit-accounting');
const discounts = require('../src/payments/discounts');
const incidents = require('../src/payments/incidents');
const providerOperations = require('../src/payments/provider-operations');
const renewalCredits = require('../src/payments/service-credit-renewals');

const suffix = crypto.randomBytes(6).toString('hex');
function unique(label) { return `${label}-${suffix}-${crypto.randomBytes(3).toString('hex')}`; }
async function customer(label) {
  return (await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`, [label, `${unique(label)}@example.invalid`])).rows[0];
}
async function plan(label, priceMinor = 1000) {
  return (await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class) VALUES($1,$2,'jellyfin','direct','month',30,$3,'GBP',100,TRUE,TRUE,1,'premium') RETURNING *`, [unique(label), label, priceMinor])).rows[0];
}
async function seedCredit(customerId, amountMinor, label) {
  await query(`INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,reference_id,note) VALUES($1,'GBP',$2,'adjustment','available',$3,$4)`, [customerId, amountMinor, unique(label), label]);
}
async function expectCode(fn, code) {
  let error = null;
  try { await fn(); } catch (caught) { error = caught; }
  assert(error, `Expected ${code} failure`);
  assert.strictEqual(error.code, code, `Expected ${code}, got ${error.code || error.message}`);
  return error;
}

async function providerCheckoutIdentityInvariant() {
  const first = await customer('provider-checkout-a');
  const second = await customer('provider-checkout-b');
  const a = await intents.createIntent({ scope: 'customer', customerId: first.id, provider: 'stripe', checkoutMode: 'payment', commercialSnapshot: {} });
  await expectCode(() => intents.attachProviderCheckout(a.id, '   '), 'PROVIDER_CHECKOUT_ID_REQUIRED');
  const external = `cs_temporal_${suffix}`;
  const attached = await intents.attachProviderCheckout(a.id, external);
  assert.strictEqual(attached.provider_checkout_id, external);
  const replay = await intents.attachProviderCheckout(a.id, external);
  assert.strictEqual(replay.id, a.id, 'exact provider checkout binding replay must be idempotent');
  await expectCode(() => intents.attachProviderCheckout(a.id, `${external}_other`), 'PROVIDER_CHECKOUT_REBIND_CONFLICT');

  const b = await intents.createIntent({ scope: 'customer', customerId: second.id, provider: 'stripe', checkoutMode: 'payment', commercialSnapshot: {} });
  await expectCode(() => intents.attachProviderCheckout(b.id, external), 'PROVIDER_CHECKOUT_IDENTITY_CONFLICT');
  const rows = await query(`SELECT id FROM billing_checkout_intents WHERE provider='stripe' AND provider_checkout_id=$1`, [external]);
  assert.strictEqual(rows.rowCount, 1, 'one provider checkout identity must map to exactly one local intent');
}

async function attachedCancellationCreditInvariant() {
  const owner = await customer('late-credit');
  await seedCredit(owner.id, 1000, 'late-credit-seed');
  const intent = await intents.createIntent({ scope: 'customer', customerId: owner.id, provider: 'stripe', checkoutMode: 'payment', commercialSnapshot: {} });
  const reserved = await creditReservations.reserveForIntent({ customerId: owner.id, checkoutIntentId: intent.id, currency: 'GBP', maxAmountMinor: 500, expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
  assert.strictEqual(reserved.amountMinor, 500);
  const external = `cs_late_credit_${suffix}`;
  await intents.attachProviderCheckout(intent.id, external);
  assert.strictEqual(await intents.cancelForOwner('customer', owner.id), 1);
  let reservation = await creditReservations.reservationForIntent(intent.id);
  assert.strictEqual(reservation.state, 'reserved', 'local cancellation of an attached checkout released service credit too early');
  assert.strictEqual(await accounting.rawAvailableMinorForClient({ query }, owner.id, 'GBP'), 500, 'attached cancelled checkout must keep its reserved credit unavailable elsewhere');

  const completed = await intents.completeVerifiedProvider('stripe', external, 'completed');
  assert.strictEqual(completed.state, 'completed', 'late provider-paid checkout did not become completed');
  reservation = await creditReservations.reservationForIntent(intent.id);
  assert.strictEqual(reservation.state, 'applied', 'late provider-paid checkout did not consume its service credit');
  const debit = await query(`SELECT * FROM affiliate_credit_ledger WHERE entry_type='redeemed' AND reference_id=$1`, [`mixed-checkout:${intent.id}`]);
  assert.strictEqual(debit.rowCount, 1, 'late provider settlement must create exactly one service-credit debit');
  assert.strictEqual(Number(debit.rows[0].amount_minor), -500);
  assert.strictEqual(await accounting.rawAvailableMinorForClient({ query }, owner.id, 'GBP'), 500, 'late provider settlement produced the wrong remaining balance');
}

async function frozenDiscountInvariant() {
  const owner = await customer('frozen-discount');
  const p = await plan('Frozen discount plan', 1000);
  const code = unique('FROZEN').toUpperCase();
  const discount = (await query(`INSERT INTO discount_codes(code,discount_type,percent_off,max_redemptions,per_customer_limit,active) VALUES($1,'percent',20,1,1,TRUE) RETURNING *`, [code])).rows[0];
  const intent = await intents.createIntent({ scope: 'customer', customerId: owner.id, planId: p.id, provider: 'stripe', checkoutMode: 'payment', commercialSnapshot: { kind:'direct_plan',planId:p.id,provider:'stripe',checkoutMode:'payment' } });
  const frozen = await discounts.reserveForIntent({ code, planCode: p.code, customerId: owner.id, checkoutIntentId: intent.id, baseMinor: 1000, ttlMinutes: 30 });
  assert.strictEqual(Number(frozen.reservation.amount_applied_minor), 200);
  const snapshot = { kind:'direct_plan',planId:p.id,provider:'stripe',checkoutMode:'payment',checkoutIntentId:intent.id,discountCodeId:discount.id,discountReservationId:frozen.reservation.id,priceMinor:1000,grossDiscountedMinor:800,discountedMinor:300 };
  await query(`UPDATE billing_checkout_intents SET commercial_snapshot=$2::jsonb WHERE id=$1`, [intent.id, JSON.stringify(snapshot)]);
  const sub = (await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,commercial_snapshot) VALUES($1,$2,'active','stripe',$3,NOW(),NOW()+INTERVAL '30 days',$4::jsonb) RETURNING *`, [owner.id, p.id, `pi_discount_${suffix}`, JSON.stringify(snapshot)])).rows[0];

  await query(`UPDATE discount_codes SET redemption_count=max_redemptions WHERE id=$1`, [discount.id]);
  const result = await transaction(client => discounts.redeemForSubscriptionTx(client, { discountCodeId: discount.id, customerId: owner.id, subscriptionId: sub.id, amountAppliedMinor: 700 }));
  assert.strictEqual(result.frozenReservation, true, 'late fulfillment did not honor its checkout-time discount authorization');
  const redemption = (await query(`SELECT * FROM discount_redemptions WHERE subscription_id=$1`, [sub.id])).rows[0];
  assert(redemption, 'frozen discount was not recorded at provider settlement');
  assert.strictEqual(Number(redemption.amount_applied_minor), 200, 'discount accounting used provider/service-credit delta instead of the exact frozen discount amount');
  const countAfterFirst = Number((await query(`SELECT redemption_count FROM discount_codes WHERE id=$1`, [discount.id])).rows[0].redemption_count);
  assert.strictEqual(countAfterFirst, 2, 'provider-truth late redemption must be recorded even after nominal capacity was consumed');
  await transaction(client => discounts.redeemForSubscriptionTx(client, { discountCodeId: discount.id, customerId: owner.id, subscriptionId: sub.id, amountAppliedMinor: 999 }));
  const countAfterReplay = Number((await query(`SELECT redemption_count FROM discount_codes WHERE id=$1`, [discount.id])).rows[0].redemption_count);
  assert.strictEqual(countAfterReplay, countAfterFirst, 'duplicate fulfillment incremented the discount redemption count twice');
}

async function incidentReopenInvariant() {
  const owner = await customer('incident-reopen');
  const caseId = `dp_temporal_${suffix}`;
  const incident = (await query(`INSERT INTO payment_incidents(provider,provider_event_id,provider_case_id,incident_type,incident_status,scope,customer_id,access_action,metadata,resolved_at) VALUES('stripe',$1,$2,'dispute','resolved','direct',$3,'suspend','{}'::jsonb,NOW()) RETURNING *`, [unique('evt-reopen'), caseId, owner.id])).rows[0];
  await incidents.reopen(incident.id, null);
  const hold = await query(`SELECT * FROM customer_access_holds WHERE customer_id=$1 AND hold_type='payment_risk' AND source_key=$2 AND released_at IS NULL`, [owner.id, `stripe:${caseId}`]);
  assert.strictEqual(hold.rowCount, 1, 'reopening a suspend incident did not restore its deterministic payment-risk hold');
  const state = await query(`SELECT status FROM customer_provisioning_state WHERE customer_id=$1`, [owner.id]);
  assert(state.rowCount, 'incident-triggered access reconciliation did not leave durable provisioning state');
}

async function providerOperationIdentityInvariant() {
  const ownerA = await customer('provider-op-a');
  const ownerB = await customer('provider-op-b');
  const idempotencyKey = `post443-op-${suffix}`;
  const args = { provider:'stripe',scope:'customer',ownerId:ownerA.id,operationType:'renewal_stop',localReference:'sub-local-a',idempotencyKey,request:{subscriptionId:'sub-local-a',desired:true} };
  const first = await providerOperations.begin(args);
  const replay = await providerOperations.begin(args);
  assert.strictEqual(replay.id, first.id, 'exact provider operation retry should reuse the original operation');
  await expectCode(() => providerOperations.begin({ ...args, ownerId: ownerB.id }), 'PROVIDER_OPERATION_IDEMPOTENCY_CONFLICT');
  await expectCode(() => providerOperations.begin({ ...args, request:{subscriptionId:'sub-local-a',desired:false} }), 'PROVIDER_OPERATION_IDEMPOTENCY_CONFLICT');
  const rows = await query(`SELECT id FROM provider_operations WHERE idempotency_key=$1`, [idempotencyKey]);
  assert.strictEqual(rows.rowCount, 1, 'idempotency conflict created a second provider operation');
}

async function renewalCreditIdentityInvariant() {
  const ownerA = await customer('renewal-a');
  const ownerB = await customer('renewal-b');
  const p = await plan('Renewal identity plan', 600);
  const subAId = `sub_renewal_a_${suffix}`;
  const subBId = `sub_renewal_b_${suffix}`;
  const subA = (await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,price_minor_snapshot,currency_snapshot) VALUES($1,$2,'active','stripe',$3,NOW(),NOW()+INTERVAL '30 days',600,'GBP') RETURNING *`, [ownerA.id, p.id, subAId])).rows[0];
  await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,price_minor_snapshot,currency_snapshot) VALUES($1,$2,'active','stripe',$3,NOW(),NOW()+INTERVAL '30 days',600,'GBP')`, [ownerB.id, p.id, subBId]);
  await seedCredit(ownerA.id, 1000, 'renewal-a-seed');
  await seedCredit(ownerB.id, 1000, 'renewal-b-seed');
  const invoiceId = `in_temporal_${suffix}`;
  const first = await renewalCredits.reserveStripeInvoice({ providerInvoiceId: invoiceId, providerSubscriptionId: subAId, currency:'GBP', maxAmountMinor:600 });
  assert.strictEqual(first.amountMinor, 600);
  const replayZero = await renewalCredits.reserveStripeInvoice({ providerInvoiceId: invoiceId, providerSubscriptionId: subAId, currency:'GBP', maxAmountMinor:0 });
  assert.strictEqual(replayZero.id, first.id, 'duplicate invoice replay with changed amount did not recover its existing reservation');
  await expectCode(() => renewalCredits.reserveStripeInvoice({ providerInvoiceId: invoiceId, providerSubscriptionId: subAId, currency:'EUR', maxAmountMinor:600 }), 'SERVICE_CREDIT_RENEWAL_IDENTITY_CONFLICT');
  await expectCode(() => renewalCredits.reserveStripeInvoice({ providerInvoiceId: invoiceId, providerSubscriptionId: subBId, currency:'GBP', maxAmountMinor:600 }), 'SERVICE_CREDIT_RENEWAL_IDENTITY_CONFLICT');
  const applied = await renewalCredits.markStripeApplied({ providerInvoiceId: invoiceId, providerAdjustmentId:`ii_temporal_${suffix}` });
  assert.strictEqual(applied.subscriptionId, subA.id);
  await expectCode(() => renewalCredits.markStripeApplied({ providerInvoiceId: invoiceId, providerAdjustmentId:`ii_temporal_other_${suffix}` }), 'SERVICE_CREDIT_RENEWAL_IDENTITY_CONFLICT');
  await expectCode(() => renewalCredits.consumeStripeInvoice({ providerInvoiceId: invoiceId, providerAdjustmentId:`ii_temporal_wrong_${suffix}` }), 'SERVICE_CREDIT_RENEWAL_IDENTITY_CONFLICT');
}

async function migrationInvariant() {
  const index = await query(`SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='billing_checkout_intents_provider_checkout_uidx'`);
  assert.strictEqual(index.rowCount, 1, 'provider checkout unique index migration was not applied');
  assert(/UNIQUE INDEX/i.test(index.rows[0].indexdef), 'provider checkout identity index is not unique');
}

async function main() {
  await providerCheckoutIdentityInvariant();
  await attachedCancellationCreditInvariant();
  await frozenDiscountInvariant();
  await incidentReopenInvariant();
  await providerOperationIdentityInvariant();
  await renewalCreditIdentityInvariant();
  await migrationInvariant();
  console.log('post-443 payment temporal consistency DB smoke: ok');
}

main().then(() => getPool().end()).catch(async error => {
  console.error(error.stack || error);
  try { await getPool().end(); } catch (_) {}
  process.exit(1);
});
