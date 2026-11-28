'use strict';

// Regression coverage for the payment/subscription fixes: provider billing frequency, recurring settlement
// verification, immediate-upgrade collection, promo handling on plan changes and the checkout burst limiter.
// No database or network access.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

// ---------- Finding 2: provider billing interval AND multiplier -----------------------------------------------------
{
  const verification = require('../src/payments/provider-mapping-verification');
  const base = { active: true, amountMinor: 1000, currency: 'GBP' };
  const check = (remote, billingInterval) => verification.compare(remote, {
    priceMinor: 1000, currency: 'GBP', checkoutMode: 'subscription', billingInterval
  });

  assert.deepStrictEqual(check({ ...base, interval: 'month', intervalCount: 1 }, 'month'), [], 'monthly = 1 month');
  assert.deepStrictEqual(check({ ...base, interval: 'month', intervalCount: 6 }, '6_months'), [], 'six-monthly = 6 months');
  assert.deepStrictEqual(check({ ...base, interval: 'year', intervalCount: 1 }, 'year'), [], 'annual = 1 year');

  // A six-monthly plan mapped to a monthly provider price would charge six times as often as sold.
  assert(check({ ...base, interval: 'month', intervalCount: 1 }, '6_months').some(i => /interval count is 1, expected 6/.test(i)), 'monthly price on a six-monthly plan must drift');
  // The same unit with the wrong multiplier on every supported plan.
  assert(check({ ...base, interval: 'month', intervalCount: 3 }, 'month').some(i => /interval count is 3, expected 1/.test(i)), 'quarterly price on a monthly plan must drift');
  assert(check({ ...base, interval: 'year', intervalCount: 2 }, 'year').some(i => /interval count is 2, expected 1/.test(i)), 'two-yearly price on an annual plan must drift');
  assert(check({ ...base, interval: 'month', intervalCount: 12 }, 'year').length >= 1, '12 months is not recorded as a yearly provider price');
  assert(check({ ...base, interval: 'year', intervalCount: 1 }, '6_months').some(i => /interval is year, expected month/.test(i)), 'wrong unit must drift');
  // A provider that omits the count means 1 (PayPal and Stripe default), which is wrong for six-monthly.
  assert(check({ ...base, interval: 'month' }, '6_months').length >= 1);
  assert.deepStrictEqual(check({ ...base, interval: 'month' }, 'month'), [], 'missing count defaults to 1');
  assert(check({ ...base, interval: null }, 'month').some(i => /not recurring/.test(i)));
  assert.deepStrictEqual(verification.expectedFrequency({ billing_interval: '6_months' }), { interval: 'month', count: 6 });
  assert.strictEqual(verification.expectedFrequency({ billing_interval: 'custom' }), null, 'unknown intervals are not guessed');

  // The verification result drives whether a mapping stays sellable.
  const drift = verification.fields({ issues: ['interval count is 1, expected 6'], remote: { interval: 'month' } });
  assert.strictEqual(drift.verificationStatus, 'drift');
}

// ---------- Finding 8: recurring settlement verification (Stripe) ---------------------------------------------------
{
  const stripe = require('../src/payments/stripe');
  const snapshot = {
    checkoutIntentId: '11111111-1111-4111-8111-111111111111', providerMappingId: 'price_monthly', priceMinor: 1000,
    discountedMinor: 1000, currency: 'GBP', billingInterval: 'month', serviceCreditMinor: 0, discountCodeId: null
  };
  const goodSession = (over = {}) => ({
    id: 'cs_1', mode: 'subscription', payment_status: 'paid', customer: 'cus_1', subscription: 'sub_1', currency: 'gbp',
    amount_subtotal: 1000, amount_total: 1000, total_details: { amount_discount: 0, amount_tax: 0 },
    metadata: { internal_customer_id: 'c1', internal_checkout_intent_id: snapshot.checkoutIntentId }, ...over
  });
  const goodSub = (over = {}) => ({
    id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { internal_customer_id: 'c1', internal_checkout_intent_id: snapshot.checkoutIntentId },
    items: { data: [{ quantity: 1, price: { id: 'price_monthly', unit_amount: 1000, currency: 'gbp', recurring: { interval: 'month', interval_count: 1 } } }] },
    latest_invoice: { status: 'paid', billing_reason: 'subscription_create', currency: 'gbp', amount_paid: 1000, amount_due: 0 }, ...over
  });
  const verify = (session, sub, snap = snapshot, stored = 'cus_1') => stripe.verifyStripeRecurringSettlement({ session, subscription: sub, snapshot: snap, storedProviderCustomerId: stored });
  const refuses = (fn, pattern, label) => assert.throws(fn, error => error.code === 'STRIPE_RECURRING_SETTLEMENT_UNVERIFIED' && pattern.test(error.message), label);

  assert.deepStrictEqual(verify(goodSession(), goodSub()), { paymentVerified: true, zeroCost: false }, 'a fully matching paid checkout verifies');

  // An active agreement alone is never proof of payment.
  refuses(() => verify(goodSession(), goodSub({ latest_invoice: { status: 'open', billing_reason: 'subscription_create', currency: 'gbp', amount_paid: 0, amount_due: 1000 } })), /not paid/, 'unpaid first invoice');
  refuses(() => verify(goodSession(), goodSub({ latest_invoice: null })), /not paid/, 'no invoice evidence');
  refuses(() => verify(goodSession(), goodSub({ latest_invoice: { status: 'paid', billing_reason: 'subscription_cycle', currency: 'gbp', amount_paid: 1000 } })), /not paid/, 'wrong invoice reason');
  refuses(() => verify(goodSession(), goodSub({ latest_invoice: { status: 'paid', billing_reason: 'subscription_create', currency: 'gbp', amount_paid: 500 } })), /not paid/, 'amount paid differs from the checkout');
  refuses(() => verify(goodSession(), goodSub({ status: 'past_due' })), /not active/, 'past_due agreement');

  // Contract: amount, currency, plan price, frequency, identity.
  refuses(() => verify(goodSession({ amount_subtotal: 900, amount_total: 900 }), goodSub()), /amount/, 'underpaid checkout');
  refuses(() => verify(goodSession({ currency: 'usd' }), goodSub()), /currency/, 'wrong currency');
  refuses(() => verify(goodSession(), goodSub({ items: { data: [{ quantity: 1, price: { id: 'price_other', unit_amount: 1000, currency: 'gbp', recurring: { interval: 'month', interval_count: 1 } } }] } })), /price does not match/, 'wrong price id');
  refuses(() => verify(goodSession(), goodSub({ items: { data: [{ quantity: 1, price: { id: 'price_monthly', unit_amount: 700, currency: 'gbp', recurring: { interval: 'month', interval_count: 1 } } }] } })), /price amount/, 'wrong unit amount');
  refuses(() => verify(goodSession(), goodSub({ items: { data: [{ quantity: 1, price: { id: 'price_monthly', unit_amount: 1000, currency: 'gbp', recurring: { interval: 'month', interval_count: 3 } } }] } })), /frequency/, 'wrong billing frequency');
  refuses(() => verify(goodSession(), goodSub({ customer: 'cus_other' })), /customer/, 'subscription customer differs from the session');
  refuses(() => verify(goodSession(), goodSub(), snapshot, 'cus_known_for_account'), /customer/, 'customer differs from the one the account checked out under');
  refuses(() => verify(goodSession(), goodSub({ id: 'sub_2' })), /does not belong/, 'subscription is not the session subscription');
  refuses(() => verify(goodSession(), goodSub({ metadata: { internal_checkout_intent_id: '22222222-2222-4222-8222-222222222222' } })), /different checkout intent/, 'another intent');
  refuses(() => verify(goodSession(), goodSub({ items: { data: [] } })), /exactly the purchased plan/, 'no plan item');

  // Tax added by the Stripe account is not part of the frozen contract and must not block a genuine payment.
  assert.deepStrictEqual(
    verify(goodSession({ amount_total: 1200, total_details: { amount_discount: 0, amount_tax: 200 } }), goodSub({ latest_invoice: { status: 'paid', billing_reason: 'subscription_create', currency: 'gbp', amount_paid: 1200 } })),
    { paymentVerified: true, zeroCost: false });
  assert.strictEqual(stripe.sessionNetMinor({ amount_subtotal: 1000, total_details: { amount_discount: 400 }, amount_total: 600 }), 600);

  // Promo / service credit: discounted first invoice verifies against the discounted contract amount.
  const discounted = { ...snapshot, discountedMinor: 700, serviceCreditMinor: 0, discountCodeId: 'd1' };
  assert.strictEqual(verify(goodSession({ amount_subtotal: 1000, amount_total: 700, total_details: { amount_discount: 300 } }),
    goodSub({ latest_invoice: { status: 'paid', billing_reason: 'subscription_create', currency: 'gbp', amount_paid: 700 } }), discounted).paymentVerified, true);
  refuses(() => verify(goodSession(), goodSub(), discounted), /amount/, 'full price paid against a discounted contract is still a mismatch');

  // Zero-cost: legitimate only when the contract itself made it free.
  const free = { ...snapshot, discountedMinor: 0, serviceCreditMinor: 1000, discountCodeId: null };
  const zeroSession = goodSession({ payment_status: 'no_payment_required', amount_subtotal: 1000, amount_total: 0, total_details: { amount_discount: 1000 } });
  const zeroSub = goodSub({ latest_invoice: { status: 'paid', billing_reason: 'subscription_create', currency: 'gbp', amount_paid: 0, amount_due: 0 } });
  assert.deepStrictEqual(verify(zeroSession, zeroSub, free), { paymentVerified: false, zeroCost: true }, 'service-credit-funded zero cost');
  assert.deepStrictEqual(verify(zeroSession, zeroSub, { ...free, serviceCreditMinor: 0, discountCodeId: 'd1' }), { paymentVerified: false, zeroCost: true }, 'promo-funded zero cost');
  refuses(() => verify(zeroSession, zeroSub, snapshot), /no payment was required|not a zero-cost|amount does not match/, 'a paid-price contract may not be satisfied by "no payment required"');
  refuses(() => verify(zeroSession, goodSub({ latest_invoice: { status: 'paid', billing_reason: 'subscription_create', currency: 'gbp', amount_paid: 300, amount_due: 0 } }), free), /non-zero/, 'zero checkout with a charged invoice');
  refuses(() => verify(goodSession({ amount_subtotal: 1000, amount_total: 0, total_details: { amount_discount: 1000 } }), goodSub(), free), /should have cost nothing/, 'a payment reported for a free contract');

  // Source: the verification gates activation and the exact intent id is what binds the session.
  const stripeSource = read('src/payments/stripe.js');
  assert(/verifyStripeRecurringSettlement\(\{session:verified,subscription/.test(stripeSource), 'activation must verify before activating');
  assert(stripeSource.indexOf('verifyStripeRecurringSettlement({session:verified') < stripeSource.indexOf('lifecycle.activatePurchase({customerId,planId,provider:\'stripe\',providerCustomerId,providerSubscriptionId:subscription.id'), 'verification precedes activatePurchase');
  assert(/checkoutIntentId:intentId/.test(stripeSource) && /internal_checkout_intent_id/.test(stripeSource), 'Stripe contract verification uses the exact intent id');
  assert(/providerPaymentVerified:settlement\.paymentVerified/.test(stripeSource), 'payment-verified flag comes from invoice evidence, not the agreement status');
}

// ---------- Finding 8: recurring settlement verification (PayPal) ---------------------------------------------------
{
  const paypal = require('../src/payments/paypal');
  const snapshot = { currency: 'GBP', priceMinor: 1000, discountedMinor: 1000 };
  const sub = payment => ({ status: 'ACTIVE', billing_info: payment === undefined ? {} : { last_payment: payment } });
  const paid = (value, currency = 'GBP') => ({ amount: { value, currency_code: currency }, time: '2026-11-28T10:00:00Z' });
  assert.strictEqual(paypal.verifiedRecurringPayment(sub(), snapshot), false, 'an ACTIVE agreement with no collected payment is not proof');
  assert.strictEqual(paypal.verifiedRecurringPayment(sub(paid('10.00')), snapshot), true, 'collected first payment verifies');
  assert.strictEqual(paypal.verifiedRecurringPayment(sub(paid('9.99')), snapshot), false, 'collected less than the contract');
  assert.strictEqual(paypal.verifiedRecurringPayment(sub(paid('10.80')), snapshot), true, 'tax added by PayPal never blocks a genuine payment');
  assert.strictEqual(paypal.verifiedRecurringPayment(sub(paid('10.00', 'USD')), snapshot), false, 'wrong currency');
  assert.strictEqual(paypal.verifiedRecurringPayment(sub({ amount: { value: '10.00', currency_code: 'GBP' } }), snapshot), false, 'no payment time');
  assert.strictEqual(paypal.verifiedRecurringPayment(sub(paid('0.00')), snapshot), false, 'a zero payment proves nothing');
  const pending = paypal.firstPaymentPending();
  assert.strictEqual(pending.code, 'PAYPAL_FIRST_PAYMENT_PENDING');
  assert.strictEqual(pending.retryable, true, 'pending payment is retryable, never terminal');

  const paypalSource = read('src/payments/paypal.js');
  assert(/if\(!alreadySettled&&!verifiedRecurringPayment\(subscription,snapshot\)\)throw firstPaymentPending\(\)/.test(paypalSource), 'first activation requires collected payment');
  assert(/reference_id:String\(checkoutIntentId\)/.test(paypalSource) && /checkoutIntentId:uuidOrNull\(unit\?\.reference_id\)/.test(paypalSource), 'one-time order carries and reads the exact intent id');
  assert(/PAYPAL_FIRST_PAYMENT_PENDING/.test(read('src/platform/customer-payment-return.js')), 'return page explains a pending first payment');
  const recovery = read('src/payments/provider-checkout-recovery.js');
  assert(/PAYPAL_FIRST_PAYMENT_PENDING[\s\S]{0,200}summary\.waiting \+= 1/.test(recovery), 'recovery treats a pending first payment as waiting, not failed');
}

// ---------- Finding 5: immediate upgrades collect payment before granting access ------------------------------------
{
  const change = require('../src/payments/customer-plan-change');
  const params = change.immediateUpdateParams({
    item: { id: 'si_1' }, priceId: 'price_pro', remoteMetadata: { keep: 'yes' }, customerId: 'c1', targetPlanId: 'p2', planPriceId: 'pp2', targetQuantity: 2, proration: true
  });
  assert.strictEqual(params.proration_behavior, 'always_invoice', 'the prorated difference is invoiced immediately');
  assert.strictEqual(params.payment_behavior, 'error_if_incomplete', 'Stripe refuses the change when payment fails or needs authentication');
  assert.deepStrictEqual(params.expand, ['latest_invoice']);
  assert.strictEqual(params.items[0].price, 'price_pro');
  assert.strictEqual(params.metadata.keep, 'yes');
  assert.strictEqual(params.metadata.internal_access_quantity, '2');
  const none = change.immediateUpdateParams({ item: { id: 'si_1' }, priceId: 'price_pro', customerId: 'c1', targetPlanId: 'p2', targetQuantity: 1, proration: false });
  assert.strictEqual(none.proration_behavior, 'none');
  assert(!('payment_behavior' in none), 'no payment behaviour when nothing is prorated');

  const subscription = invoice => ({ status: 'active', items: { data: [{ price: { id: 'price_pro' } }] }, latest_invoice: invoice });
  const verify = (sub, proration = true) => change.verifyImmediateUpgradeCollected(sub, { targetPriceId: 'price_pro', proration });
  assert.strictEqual(verify(subscription({ billing_reason: 'subscription_update', status: 'paid', amount_due: 400, amount_paid: 400 })).collected, 'paid');
  // Zero-cost upgrades: no invoice, a paid zero invoice, or a credit-covered invoice all pass.
  assert.strictEqual(verify(subscription(null)).collected, 'nothing_due');
  assert.strictEqual(verify(subscription({ billing_reason: 'subscription_update', status: 'paid', amount_due: 0, amount_paid: 0 })).collected, 'nothing_due');
  assert.strictEqual(verify(subscription({ billing_reason: 'subscription_cycle', status: 'paid', amount_due: 1000, amount_paid: 1000 })).collected, 'nothing_due', 'an unrelated earlier invoice is not this upgrade');
  assert.strictEqual(verify(subscription(null), false).collected, 'not_required');
  // Failed or uncollected upgrades never grant the access.
  for (const bad of [
    subscription({ billing_reason: 'subscription_update', status: 'open', amount_due: 400, amount_paid: 0 }),
    subscription({ billing_reason: 'subscription_update', status: 'uncollectible', amount_due: 400, amount_paid: 0 }),
    { ...subscription(null), status: 'past_due' },
    { ...subscription(null), status: 'incomplete' },
    { ...subscription(null), items: { data: [{ price: { id: 'price_old' } }] } }
  ]) assert.throws(() => verify(bad), error => error.code === 'UPGRADE_PAYMENT_NOT_COLLECTED');

  const card = Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', code: 'card_declined', statusCode: 402 });
  const auth = Object.assign(new Error('requires action'), { type: 'StripeCardError', code: 'authentication_required', statusCode: 402 });
  const outage = Object.assign(new Error('boom'), { statusCode: 503 });
  const declined = change.paymentRefusalFromStripeError(card), authentication = change.paymentRefusalFromStripeError(auth);
  assert.strictEqual(declined.code, 'PLAN_CHANGE_PAYMENT_FAILED');
  assert(/unchanged/.test(declined.message) && declined.expose === true, 'failed payment explains that access is preserved');
  assert.strictEqual(authentication.code, 'PLAN_CHANGE_AUTHENTICATION_REQUIRED');
  assert(/authentication/.test(authentication.message) && /unchanged/.test(authentication.message));
  assert.strictEqual(change.paymentRefusalFromStripeError(outage), null, 'an outage is not reported as a payment failure');
  assert.strictEqual(change.paymentRefusalFromStripeError(null), null);

  const planChange = read('src/payments/customer-plan-change.js'), recovery = read('src/payments/provider-operation-recovery.js');
  assert(!/create_prorations/.test(planChange) && !/create_prorations/.test(recovery), 'no unpaid-proration upgrades remain');
  assert(planChange.indexOf('verifyImmediateUpgradeCollected(updated') < planChange.indexOf('await providerOps.providerApplied(op.id,{providerReference:updated.id'), 'collection is verified before the operation is recorded as applied');
  assert(planChange.indexOf('verifyImmediateUpgradeCollected(updated') < planChange.indexOf('await applySnapshot(db,subscriptionId'), 'collection is verified before local access changes');
  assert(recovery.indexOf('verifyImmediateUpgradeCollected(remote') < recovery.indexOf('await finishImmediateLocal(op, subscription, target, mapping)'), 'recovery verifies collection before granting access');
  assert(/stripeChangeTiming/.test(planChange) && /monthlyValue\(target\)>monthlyValue\(current\)\?'immediate':'period_end'/.test(planChange), 'downgrades still take effect at renewal');
}

// ---------- Finding 6: a promo code is applied or explicitly refused, never silently dropped ------------------------
{
  const checkout = require('../src/platform/flexible-checkout');
  assert(/remove the promo code|Remove the promo code/i.test(checkout.PROMO_NOT_APPLICABLE_TO_PLAN_CHANGE));
  assert(/Nothing was changed or charged/.test(checkout.PROMO_NOT_APPLICABLE_TO_PLAN_CHANGE));
  assert(checkout.CHECKOUT_SAFE.includes(checkout.PROMO_NOT_APPLICABLE_TO_PLAN_CHANGE), 'the customer must be able to read the refusal');
  const source = read('src/platform/flexible-checkout.js');
  const refusal = source.indexOf('throw new Error(PROMO_NOT_APPLICABLE_TO_PLAN_CHANGE)');
  const requestChange = source.indexOf('planChange.requestChange({customerId:req.session.customerId');
  assert(refusal > 0 && requestChange > 0 && refusal < requestChange, 'the refusal happens before any plan modification or payment');
  assert(/String\(req\.body\.discountCode\|\|''\)\.trim\(\)/.test(source.slice(refusal - 120, refusal)), 'any submitted code is refused, including whitespace-trimmed input');
}

// ---------- Finding 1: checkout routes sit behind a burst limiter CodeQL recognises -----------------------------------
{
  const checkout = require('../src/platform/flexible-checkout');
  assert.strictEqual(typeof checkout.checkoutBurstLimit, 'function');
  const source = read('src/platform/flexible-checkout.js');
  assert(/require\('express-rate-limit'\)/.test(source));
  const routes = [...source.matchAll(/router\.(get|post)\('(\/account\/checkout\/[^']+)',([^)]*?)async/g)];
  assert(routes.length >= 5, 'all checkout routes are present');
  for (const [, , route, chain] of routes) {
    assert(/checkoutBurstLimit/.test(chain), `${route} must run the burst limiter`);
    assert(/requireCustomer/.test(chain), `${route} still requires a signed-in customer`);
    assert(chain.indexOf('checkoutBurstLimit') < chain.indexOf('requireCustomer'), `${route} limits before authorization work`);
  }
  assert(!/plisio/i.test(source), 'Plisio stays retired');
}

// ---------- Finding 4: ambiguous provider outcomes use stable idempotency and exact-intent recovery -----------------------
{
  const checkout = require('../src/platform/flexible-checkout');
  const stripeModule = require('../src/payments/stripe');
  const intent = { id: '33333333-3333-4333-8333-333333333333' };
  const owner = { customerId: 'c1', intent };
  const timeout = () => Object.assign(new Error('timed out'), { retryable: true, code: 'timeout' });
  const sdkOutage = () => Object.assign(new Error('Stripe is down'), { statusCode: 503, type: 'StripeAPIError' });
  const declined = () => Object.assign(new Error('declined'), { statusCode: 402, type: 'StripeCardError', code: 'card_declined' });

  assert.strictEqual(checkout.ambiguousProviderOutcome('paypal', timeout()), true);
  assert.strictEqual(checkout.ambiguousProviderOutcome('stripe', sdkOutage()), true);
  assert.strictEqual(checkout.ambiguousProviderOutcome('stripe', Object.assign(new Error('in flight'), { statusCode: 409 })), true, 'an in-flight duplicate is ambiguous, not a failure');
  assert.strictEqual(checkout.ambiguousProviderOutcome('stripe', declined()), false, 'a definitive refusal is not ambiguous');
  assert.strictEqual(checkout.ambiguousProviderOutcome('stripe', Object.assign(new Error('bad'), { planChangeRefusal: true })), false);

  (async () => {
    // A lost response is retried with the identical call (same idempotency key), so one checkout results.
    let calls = 0;
    const result = await checkout.createProviderCheckoutRecoverably('stripe', async () => { calls += 1; if (calls === 1) throw timeout(); return { id: 'cs_1', url: 'https://x', mode: 'subscription' }; }, owner);
    assert.strictEqual(result.id, 'cs_1'); assert.strictEqual(calls, 2);

    // Definitive errors are surfaced at once and never retried.
    calls = 0;
    await assert.rejects(() => checkout.createProviderCheckoutRecoverably('stripe', async () => { calls += 1; throw declined(); }, owner), /declined/);
    assert.strictEqual(calls, 1);

    // Still ambiguous: provider truth is established by the exact intent id.
    const original = stripeModule.recoverUnattachedCheckout;
    try {
      let seen = null;
      stripeModule.recoverUnattachedCheckout = async arg => { seen = arg; return { session: { id: 'cs_found', url: 'https://found', mode: 'subscription' } }; };
      assert.strictEqual((await checkout.createProviderCheckoutRecoverably('stripe', async () => { throw timeout(); }, owner)).id, 'cs_found', 'an existing session is re-attached, not duplicated');
      assert.deepStrictEqual(seen, { customerId: 'c1', intentId: intent.id }, 'looked up by the exact intent id');

      stripeModule.recoverUnattachedCheckout = async () => ({ none: true });
      let failure = await checkout.createProviderCheckoutRecoverably('stripe', async () => { throw timeout(); }, owner).catch(error => error);
      assert.strictEqual(failure.message, checkout.CHECKOUT_UNCONFIRMED_MESSAGE);
      assert.strictEqual(failure.keepIntentOpen, false, 'confirmed absence: nothing can be paid, reservations may be released');

      for (const outcome of [{ unconfirmed: true, reason: 'down' }, { completed: true, sessionId: 'cs_paid' }]) {
        stripeModule.recoverUnattachedCheckout = async () => outcome;
        failure = await checkout.createProviderCheckoutRecoverably('stripe', async () => { throw timeout(); }, owner).catch(error => error);
        assert.strictEqual(failure.keepIntentOpen, true, 'unknown or already-paid provider state must keep the intent and its reservations');
      }
    } finally { stripeModule.recoverUnattachedCheckout = original; }

    const source = read('src/platform/flexible-checkout.js');
    assert(/if\(!error\?\.keepIntentOpen\)await intents\.consume/.test(source), 'unconfirmed intents are not marked failed');
    assert(/idempotencyKey:intent\.id/.test(source), 'creation is keyed by the local intent id');
    console.log('payment fixes pure smoke (async): ok');
  })().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}

console.log('payment fixes pure smoke: ok');
