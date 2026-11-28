'use strict';

// Database-backed regression coverage for: PayPal one-time settlement ordering, exact-intent provider checkout association
// and provider settings refresh / disabled-provider behaviour. Provider network calls are stubbed; nothing is charged.
require('dotenv').config();
const assert = require('assert');
const { query } = require('../src/db');
const { runDbSmoke, unique: fixtureUnique, fixtureCustomer, fixturePlan } = require('./test-fixture');
const intents = require('../src/payments/checkout-intents');
const discounts = require('../src/payments/discounts');
const lifecycle = require('../src/payments/lifecycle');
const livePaypalHistory = require('../src/payments/live-paypal-payment-history');
const paypal = require('../src/payments/paypal');
const stripe = require('../src/payments/stripe');
const providerSettings = require('../src/payments/provider-settings');
const settlementReview = require('../src/payments/settlement-review');

const suffix = fixtureUnique('payfix');
const created = { customers: [], plans: [], intents: [], servers: [], codes: [] };
const unique = label => `${label}-${suffix}-${fixtureUnique('case')}`;

async function server() {
  const row = (await query(`
    INSERT INTO jellyfin_servers(name,slug,server_class,base_url,public_url,location,api_key_encrypted,enabled,allow_new_users,paid_enabled,priority,max_users,health_status,last_health_check)
    VALUES($1,$2,'premium','https://payfix.example.invalid','https://payfix.example.invalid','Payfix','key',TRUE,TRUE,TRUE,10,1000,'healthy',NOW())
    RETURNING id,location`, [`Payfix ${suffix}`, unique('payfix-server')])).rows[0];
  created.servers.push(row.id);
  return row;
}
async function customer(label) {
  const row = await fixtureCustomer({ query }, { displayName: label, email: `${unique(label)}@example.invalid` });
  created.customers.push(row.id);
  return row;
}
async function plan(label, srv, interval = 'month') {
  const row = await fixturePlan({ query }, {
    code: unique(label), name: label, serviceType: 'jellyfin', audience: 'direct', billingInterval: interval, durationDays: 30,
    priceMinor: 1000, currency: 'GBP', capacityLimit: 100, streams: 1, serverClass: 'premium'
  });
  created.plans.push(row.id);
  await query('INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,100)', [row.id, srv.id]);
  return { ...row, test_media_location: srv.location };
}
const snapshotFor = (p, provider, mode, extra = {}) => ({
  kind: 'direct_plan', planId: p.id, planPriceId: null, planCode: p.code, planName: p.name, priceMinor: 1000, discountedMinor: 1000,
  currency: 'GBP', billingInterval: 'month', durationDays: 30, streams: 1, stremioHouseholdNetworkLimit: 1, provider,
  checkoutMode: mode, providerMappingId: null, providerMappingRecordId: null, mediaLocation: p.test_media_location, ...extra
});
const stateOf = async id => (await query('SELECT state,provider_checkout_id FROM billing_checkout_intents WHERE id=$1', [id])).rows[0];

async function cleanup() {
  await query("DELETE FROM payment_incidents WHERE provider_event_id LIKE $1", [`settlement-review:%${suffix}%`]).catch(() => {});
  if (created.intents.length) await query('DELETE FROM billing_checkout_intents WHERE id=ANY($1::uuid[])', [created.intents]).catch(() => {});
  if (created.codes.length) await query('DELETE FROM discount_codes WHERE id=ANY($1::uuid[])', [created.codes]).catch(() => {});
  if (created.plans.length) await query('DELETE FROM plans WHERE id=ANY($1::uuid[])', [created.plans]).catch(() => {});
  if (created.customers.length) await query('DELETE FROM customers WHERE id=ANY($1::uuid[])', [created.customers]).catch(() => {});
  if (created.servers.length) await query('DELETE FROM jellyfin_servers WHERE id=ANY($1::uuid[])', [created.servers]).catch(() => {});
}

// ---------------------------------------------------------------------------------------------------------------------
// Finding 3: PayPal one-time settlement order. Capture on record -> entitlement -> only then complete the checkout.
async function paypalSettlementOrdering(srv) {
  const owner = await customer('paypal settle');
  const p = await plan('paypal settle plan', srv);
  const code = unique('PROMO').toUpperCase();
  const discount = (await query(`INSERT INTO discount_codes(code,discount_type,percent_off,max_redemptions,per_customer_limit,active) VALUES($1,'percent',10,5,1,TRUE) RETURNING *`, [code])).rows[0];
  created.codes.push(discount.id);

  const intent = await intents.createIntent({ scope: 'customer', customerId: owner.id, planId: p.id, provider: 'paypal', checkoutMode: 'payment', commercialSnapshot: snapshotFor(p, 'paypal', 'payment') });
  created.intents.push(intent.id);
  const reservation = await discounts.reserveForIntent({ code, planCode: p.code, customerId: owner.id, checkoutIntentId: intent.id, baseMinor: 1000, currency: 'GBP', ttlMinutes: 30 });
  const frozen = { ...snapshotFor(p, 'paypal', 'payment'), checkoutIntentId: intent.id, discountCodeId: discount.id, discountReservationId: reservation.reservation.id, grossDiscountedMinor: 900, discountedMinor: 900, discountCode: code };
  await query('UPDATE billing_checkout_intents SET commercial_snapshot=$2::jsonb WHERE id=$1', [intent.id, JSON.stringify(frozen)]);
  const orderId = `ORDER-${unique('o')}`;
  await intents.attachProviderCheckout(intent.id, orderId);

  const order = {
    id: orderId, status: 'COMPLETED', payer: { payer_id: 'PAYER1' },
    purchase_units: [{
      reference_id: intent.id, custom_id: `${owner.id}:${p.id}:${discount.id}`, amount: { value: '9.00', currency_code: 'GBP' },
      payments: { captures: [{ id: `CAP-${unique('c')}`, amount: { value: '9.00', currency_code: 'GBP' } }] }
    }]
  };

  const calls = [];
  const original = {
    recordCapture: livePaypalHistory.recordCapture, assertCaptureOwner: livePaypalHistory.assertCaptureOwner,
    activatePurchase: lifecycle.activatePurchase, complete: intents.completeVerifiedProvider
  };
  let failActivation = true;
  livePaypalHistory.assertCaptureOwner = async () => true;
  livePaypalHistory.recordCapture = async () => { calls.push('capture'); return { recorded: true }; };
  lifecycle.activatePurchase = async () => { calls.push('activate'); if (failActivation) throw Object.assign(new Error('simulated local failure'), { code: 'PLAN_CAPACITY_EXHAUSTED' }); return { id: 'sub-stub', status: 'active' }; };
  intents.completeVerifiedProvider = async (...args) => { calls.push('complete'); return original.complete(...args); };
  try {
    // A failed local activation must leave the money on record and the checkout recoverable, with nothing consumed.
    await assert.rejects(() => paypal.activateCompletedOrder(order), /simulated local failure/);
    assert.deepStrictEqual(calls, ['capture', 'activate'], 'capture is recorded first and the checkout is NOT completed when activation fails');
    assert.strictEqual((await stateOf(intent.id)).state, 'open', 'checkout stays open so recovery can finish it');
    const afterFailure = (await query('SELECT state FROM discount_checkout_reservations WHERE id=$1', [reservation.reservation.id])).rows[0];
    assert.strictEqual(afterFailure.state, 'reserved', 'the promo reservation is not consumed for a payment that received no access');
    assert.strictEqual((await query('SELECT redemption_count FROM discount_codes WHERE id=$1', [discount.id])).rows[0].redemption_count, 0);

    // Recovery re-runs the same function: the capture write is idempotent and activation now succeeds.
    calls.length = 0; failActivation = false;
    await paypal.activateCompletedOrder(order);
    assert.deepStrictEqual(calls, ['capture', 'activate', 'complete'], 'capture -> entitlement -> completion');
    assert.strictEqual((await stateOf(intent.id)).state, 'completed');
    assert.strictEqual((await query('SELECT state FROM discount_checkout_reservations WHERE id=$1', [reservation.reservation.id])).rows[0].state, 'consumed');

    // A replay (webhook plus return page plus recovery) is idempotent.
    calls.length = 0;
    await paypal.activateCompletedOrder(order);
    assert.strictEqual((await stateOf(intent.id)).state, 'completed');
  } finally {
    livePaypalHistory.recordCapture = original.recordCapture;
    livePaypalHistory.assertCaptureOwner = original.assertCaptureOwner;
    lifecycle.activatePurchase = original.activatePurchase;
    intents.completeVerifiedProvider = original.complete;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Finding 4: a provider checkout binds only to the exact local intent that created it.
async function exactIntentAssociation(srv) {
  const owner = await customer('exact intent');
  const p = await plan('exact intent plan', srv);
  const first = await intents.createIntent({ scope: 'customer', customerId: owner.id, planId: p.id, provider: 'stripe', checkoutMode: 'subscription', commercialSnapshot: snapshotFor(p, 'stripe', 'subscription', { providerMappingId: 'price_x' }) });
  created.intents.push(first.id);
  // The first attempt's outcome is lost locally and it is closed; the customer starts another attempt for the same plan.
  await intents.consume({ intentId: first.id, nonce: first.nonce, state: 'failed', scope: 'customer', provider: 'stripe', ownerId: owner.id });
  const second = await intents.createIntent({ scope: 'customer', customerId: owner.id, planId: p.id, provider: 'stripe', checkoutMode: 'subscription', commercialSnapshot: snapshotFor(p, 'stripe', 'subscription', { providerMappingId: 'price_x' }) });
  created.intents.push(second.id);
  const sessionId = `cs_test_${unique('exact')}`;
  const verify = extra => intents.verifiedProviderContract({ provider: 'stripe', providerCheckoutId: sessionId, scope: 'customer', ownerId: owner.id, planId: p.id, checkoutMode: 'subscription', providerMappingId: 'price_x', ...extra });

  // Customer + plan + mode used to be enough to attach the session to the one open intent (the second). No longer.
  await assert.rejects(() => verify({}), /no matching local checkout intent/, 'no intent id means no association');
  assert.strictEqual((await stateOf(second.id)).provider_checkout_id, null, 'the unrelated open intent is not claimed');

  // A paid session belongs to the intent that created it, even if that intent was closed locally by a lost response.
  const bound = await verify({ checkoutIntentId: first.id });
  assert.strictEqual(String(bound.intent.id), String(first.id), 'bound to the exact originating intent');
  assert.strictEqual((await stateOf(first.id)).provider_checkout_id, sessionId);
  assert.strictEqual((await stateOf(second.id)).provider_checkout_id, null, 'the other intent stays untouched');

  // Once bound, naming a different intent is a conflict, never a re-association.
  await assert.rejects(() => verify({ checkoutIntentId: second.id }), /different local checkout intent/);
  // The same session replays to the same intent.
  assert.strictEqual(String((await verify({ checkoutIntentId: first.id })).intent.id), String(first.id));
  // An intent id belonging to another customer is never accepted.
  const stranger = await customer('stranger');
  await assert.rejects(() => intents.verifiedProviderContract({ provider: 'stripe', providerCheckoutId: `cs_${unique('o')}`, scope: 'customer', ownerId: stranger.id, planId: p.id, checkoutMode: 'subscription', providerMappingId: 'price_x', checkoutIntentId: second.id }), /no matching local checkout intent/);
}

// ---------------------------------------------------------------------------------------------------------------------
// Finding 7: every process re-reads provider credentials; switching off new checkouts keeps existing payments settleable.
async function providerSettingsRefresh() {
  const rows = (await query(`SELECT * FROM payment_provider_credentials WHERE provider IN ('stripe','paypal')`)).rows;
  const previousEnv = process.env.PAYMENT_PROVIDER_SETTINGS_REFRESH_MS;
  try {
    await query(`DELETE FROM payment_provider_credentials WHERE provider IN ('stripe','paypal')`);
    providerSettings._resetForTests();
    process.env.PAYMENT_PROVIDER_SETTINGS_REFRESH_MS = '600000';
    await providerSettings.save('stripe', { enabled: true, restrictedKey: 'rk_test_first', webhookSecret: 'whsec_first' });
    assert.strictEqual((await providerSettings.get('stripe')).restrictedKey, 'rk_test_first');

    // Another process (admin save in the web app) changes the credentials directly in the database.
    const { encryptString } = require('../src/crypto');
    const rotate = secrets => query(`UPDATE payment_provider_credentials SET secrets_encrypted=$1,updated_at=NOW() WHERE provider='stripe'`, [encryptString(JSON.stringify(secrets))]);
    await rotate({ restrictedKey: 'rk_test_rotated', apiKey: '', webhookSecret: 'whsec_rotated' });

    // Inside the refresh interval a worker may still use its copy; once the interval elapses it must pick up the change.
    assert.strictEqual((await providerSettings.get('stripe')).restrictedKey, 'rk_test_first', 'not re-read inside the refresh interval');
    process.env.PAYMENT_PROVIDER_SETTINGS_REFRESH_MS = '0';
    const refreshed = await providerSettings.get('stripe');
    assert.strictEqual(refreshed.restrictedKey, 'rk_test_rotated', 'a long-running worker picks up rotated credentials without a restart');
    assert.strictEqual(refreshed.webhookSecret, 'whsec_rotated', 'and the rotated webhook secret');

    // A fresh worker process starts from the database.
    providerSettings._resetForTests();
    assert.strictEqual((await providerSettings.get('stripe')).webhookSecret, 'whsec_rotated');

    // Disabling NEW checkouts must not strand settlement of existing payments.
    await providerSettings.save('stripe', { enabled: false });
    await providerSettings.save('paypal', { enabled: false, clientId: 'cid', clientSecret: 'csecret', webhookId: 'WH-1', environment: 'sandbox' });
    assert.strictEqual(stripe.enabled(), false, 'new checkouts are off');
    assert.strictEqual(paypal.enabled(), false);
    assert.strictEqual(stripe.operational(), true, 'webhooks, refunds, sync and recovery keep their credentials');
    assert.strictEqual(paypal.operational(), true);
    assert.strictEqual((await providerSettings.get('stripe')).webhookSecret, 'whsec_rotated', 'webhook signature secret is still available');
    assert.strictEqual((await providerSettings.get('paypal')).webhookId, 'WH-1');
    const status = await providerSettings.status('stripe');
    assert.strictEqual(status.checkoutReady, false, 'but no new Stripe checkout can start');
    assert.strictEqual(status.enabled, false);
    assert.strictEqual(providerSettings.peek('stripe').restrictedKey, '', 'the checkout-facing view still hides credentials of a disabled provider');

    // A refresh that fails (here: an undecryptable stored secret) keeps the last good credentials instead of breaking payments.
    process.env.PAYMENT_PROVIDER_SETTINGS_REFRESH_MS = '0';
    const good = (await query(`SELECT secrets_encrypted FROM payment_provider_credentials WHERE provider='stripe'`)).rows[0].secrets_encrypted;
    await query(`UPDATE payment_provider_credentials SET secrets_encrypted='not-a-valid-ciphertext' WHERE provider='stripe'`);
    const originalError = console.error;
    console.error = () => {};
    try {
      assert.strictEqual((await providerSettings.get('stripe')).webhookSecret, 'whsec_rotated', 'a failed refresh keeps serving the last good credentials');
    } finally {
      console.error = originalError;
      await query(`UPDATE payment_provider_credentials SET secrets_encrypted=$1 WHERE provider='stripe'`, [good]);
    }
    // A process that has never loaded anything has no last good value, so it fails loudly rather than guessing.
    await query(`UPDATE payment_provider_credentials SET secrets_encrypted='not-a-valid-ciphertext' WHERE provider='stripe'`);
    providerSettings._resetForTests();
    await assert.rejects(() => providerSettings.get('stripe'));
    await query(`UPDATE payment_provider_credentials SET secrets_encrypted=$1 WHERE provider='stripe'`, [good]);
  } finally {
    if (previousEnv === undefined) delete process.env.PAYMENT_PROVIDER_SETTINGS_REFRESH_MS; else process.env.PAYMENT_PROVIDER_SETTINGS_REFRESH_MS = previousEnv;
    await query(`DELETE FROM payment_provider_credentials WHERE provider IN ('stripe','paypal')`);
    for (const row of rows) {
      await query(`INSERT INTO payment_provider_credentials(provider,secrets_encrypted,settings,updated_by,updated_at) VALUES($1,$2,$3::jsonb,$4,$5)`, [row.provider, row.secrets_encrypted, JSON.stringify(row.settings || {}), row.updated_by || null, row.updated_at]).catch(() => {});
    }
    providerSettings._resetForTests();
  }
}

// Paid-but-unverified settlements never withhold access: they open one access-neutral operator incident, idempotently.
async function paidSettlementFlaggedNotBlocked() {
  const owner = await customer('review flag');
  const ref = `sub_${unique('review')}`;
  const first = await settlementReview.flagForReview({ provider: 'stripe', customerId: owner.id, providerReference: ref, reasons: ['Stripe Checkout amount does not match the checkout contract.'] });
  const again = await settlementReview.flagForReview({ provider: 'stripe', customerId: owner.id, providerReference: ref, reasons: ['Stripe subscription is past_due, not active.'] });
  assert(first && again && first.id === again.id, 'a replay refreshes the same incident');
  const rows = (await query(`SELECT * FROM payment_incidents WHERE provider='stripe' AND provider_event_id=$1`, [`settlement-review:${ref}`])).rows;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].access_action, 'preserve', 'flagging never changes access');
  assert.strictEqual(rows[0].incident_status, 'open');
  assert.strictEqual(await settlementReview.flagForReview({ provider: 'stripe', customerId: owner.id, providerReference: ref, reasons: [] }), null, 'nothing to flag means no incident');
  await query(`DELETE FROM payment_incidents WHERE provider_event_id=$1`, [`settlement-review:${ref}`]);
}

runDbSmoke('payment fixes DB smoke', async () => {
  try {
    const srv = await server();
    await paypalSettlementOrdering(srv);
    await exactIntentAssociation(srv);
    await providerSettingsRefresh();
    await paidSettlementFlaggedNotBlocked();
  } finally {
    await cleanup();
  }
}).catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
