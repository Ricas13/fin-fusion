'use strict';

require('dotenv').config();
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('Checkout abandonment self-service smoke')) process.exit(0);

const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const intents = require('../src/payments/checkout-intents');
const capacity = require('../src/entitlements/plan-capacity');
const fs = require('fs');
const path = require('path');

function expect(condition, message) { if (!condition) throw new Error(message); }

async function capacityHoldCount(intentId) {
    const holdSql = capacity.checkoutReservationSql('i');
    const result = await query(`SELECT COUNT(*)::int AS n FROM billing_checkout_intents i WHERE i.id=$1 AND ${holdSql}`, [intentId]);
    return Number(result.rows[0]?.n || 0);
}

async function main() {
    const suffix = crypto.randomBytes(4).toString('hex');
    const customer = (await query(`INSERT INTO customers(display_name,email) VALUES('Abandon Test',$1) RETURNING id`, [`abandon-${suffix}@example.invalid`])).rows[0];

    const created = await intents.createIntent({ scope: 'customer', customerId: customer.id, provider: 'paypal', checkoutMode: 'payment', commercialSnapshot: {} });
    const providerCheckoutId = `ORDER-abandon-${suffix}`;
    const attached = await intents.attachProviderCheckout(created.id, providerCheckoutId);
    expect(new Date(attached.capacity_hold_until).getTime() > new Date(attached.expires_at).getTime(), 'attached PayPal checkout must extend capacity beyond the local checkout expiry.');
    expect(new Date(attached.capacity_hold_until).getTime() >= Date.now() + (6 * 60 * 60 * 1000), 'PayPal capacity backstop must cover the provider approval window with safety margin.');

    // Starting a second checkout while the first is open must still be refused --
    // this smoke exists to check that customers now have a way OUT of that state.
    await expectReject(() => intents.createIntent({ scope: 'customer', customerId: customer.id, provider: 'stripe', checkoutMode: 'payment', commercialSnapshot: {} }), /already in progress/i);

    const open = await intents.getOpenForOwner('customer', customer.id);
    expect(open && open.id === created.id, 'getOpenForOwner must find the customer\'s own stuck checkout intent.');

    const cancelledCount = await intents.cancelForOwner('customer', customer.id);
    expect(cancelledCount === 1, 'cancelForOwner must cancel exactly the customer\'s own open intent.');

    const afterCancel = await intents.getOpenForOwner('customer', customer.id);
    expect(afterCancel === null, 'no customer-open intent should remain after cancellation.');
    expect(await capacityHoldCount(created.id) === 1, 'locally cancelled attached checkout must keep reserving capacity while provider settlement is still possible.');
    const locallyCancelled = await intents.findById(created.id);
    expect(!locallyCancelled.provider_terminal_at, 'local checkout cancellation must not pretend provider-terminal truth was observed.');

    await intents.completeVerifiedProvider('paypal', providerCheckoutId, 'cancelled');
    const providerCancelled = await intents.findById(created.id);
    expect(providerCancelled.provider_terminal_at, 'verified provider cancellation must record terminal provider truth.');
    expect(await capacityHoldCount(created.id) === 0, 'verified provider cancellation must release the retained capacity immediately.');

    // Now starting a new checkout must succeed, proving the customer is unstuck
    // once the old provider checkout is conclusively terminal.
    const retried = await intents.createIntent({ scope: 'customer', customerId: customer.id, provider: 'stripe', checkoutMode: 'payment', commercialSnapshot: {} });
    expect(retried && retried.id, 'customer must be able to start a fresh checkout after cancelling the stuck one.');
    await intents.consume({ intentId: retried.id, nonce: retried.nonce, state: 'cancelled', scope: 'customer', provider: 'stripe', ownerId: customer.id });

    // Natural local expiry has the same provider-truth rule. An attached PayPal
    // checkout may outlive our 60-minute customer intent, so expiring the local
    // state must not release inventory until PayPal is terminal or the backstop ends.
    const expiryCustomer = (await query(`INSERT INTO customers(display_name,email) VALUES('Expiry Test',$1) RETURNING id`, [`expiry-${suffix}@example.invalid`])).rows[0];
    const expiring = await intents.createIntent({ scope: 'customer', customerId: expiryCustomer.id, provider: 'paypal', checkoutMode: 'payment', commercialSnapshot: {} });
    const expiryProviderId = `ORDER-expiry-${suffix}`;
    await intents.attachProviderCheckout(expiring.id, expiryProviderId);
    await query(`UPDATE billing_checkout_intents SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1`, [expiring.id]);
    const replacement = await intents.createIntent({ scope: 'customer', customerId: expiryCustomer.id, provider: 'stripe', checkoutMode: 'payment', commercialSnapshot: {} });
    const naturallyExpired = await intents.findById(expiring.id);
    expect(naturallyExpired.state === 'expired', 'starting a replacement checkout must mark the old local intent expired.');
    expect(await capacityHoldCount(expiring.id) === 1, 'locally expired attached checkout must keep reserving capacity while provider settlement is possible.');
    await intents.completeVerifiedProvider('paypal', expiryProviderId, 'cancelled');
    expect(await capacityHoldCount(expiring.id) === 0, 'provider-terminal truth must release capacity retained past local expiry.');
    await intents.consume({ intentId: replacement.id, nonce: replacement.nonce, state: 'cancelled', scope: 'customer', provider: 'stripe', ownerId: expiryCustomer.id });

    const root = path.join(__dirname, '..');
    const routeSource = fs.readFileSync(path.join(root, 'src', 'platform', 'flexible-checkout.js'), 'utf8');
    const returnSource = fs.readFileSync(path.join(root, 'src', 'platform', 'customer-payment-return.js'), 'utf8');
    const webhookSource = fs.readFileSync(path.join(root, 'src', 'platform', 'webhooks.js'), 'utf8');
    const stripeSource = fs.readFileSync(path.join(root, 'src', 'payments', 'stripe.js'), 'utf8');
    const capacitySource = fs.readFileSync(path.join(root, 'src', 'entitlements', 'plan-capacity.js'), 'utf8');
    expect(routeSource.includes("/account/checkout/cancel-open"), 'a self-service cancel-open route must exist.');
    expect(routeSource.includes('checkoutStartLimit'), 'checkout-session creation must be rate limited.');
    expect(routeSource.includes("stateUrl(req,'/account/stripe/return',intent)"), 'Stripe success must return through the verified customer return route.');
    expect(routeSource.includes('session_id={CHECKOUT_SESSION_ID}'), 'Stripe success URL must bind the returned Checkout Session ID.');
    expect(!routeSource.includes('Payment%20received.%20Your%20access%20details%20are%20below.'), 'Stripe must not show optimistic success before provider confirmation.');
    expect(returnSource.includes("r.get('/account/stripe/return',paymentReturnLimit,requireCustomer,stripeReturnHandler)"), 'Stripe return must require the authenticated customer and return rate limit.');
    expect(returnSource.includes("providerCheckoutId:sessionId")&&returnSource.includes("provider:'stripe'")&&returnSource.includes('ownerId:req.session.customerId'), 'Stripe return must verify intent, session and owner together.');
    expect(returnSource.includes('stripe.confirmCheckout(sessionId,row)'), 'Stripe return must ask the provider adapter to confirm payment state.');
    expect(stripeSource.includes('async function confirmCheckout(sessionId)')&&stripeSource.includes("case 'checkout.session.expired'"), 'Stripe adapter must own browser confirmation and expiration completion.');
    const stripeWebhook = webhookSource.match(/router\.post\('\/webhooks\/stripe'[\s\S]*?router\.post\('\/webhooks\/paypal'/)?.[0] || '';
    expect(stripeWebhook.includes('stripe.processWebhook(req.body,signature)'), 'Stripe webhook must delegate fulfillment to the Stripe adapter.');
    expect(!stripeWebhook.includes('completeCheckoutOrIncident'), 'Stripe webhook must not run a second local checkout-completion pass.');
    const paypalWebhook = webhookSource.match(/router\.post\('\/webhooks\/paypal'[\s\S]*?router\.post\('\/webhooks\/plisio'/)?.[0] || '';
    expect(paypalWebhook.includes('paypal.processWebhook(req.body,req.headers)'), 'PayPal webhook must delegate fulfillment to the PayPal adapter.');
    expect(!paypalWebhook.includes('completeCheckoutOrIncident'), 'PayPal webhook must not run a second local checkout-completion pass.');
    const paypalSource = fs.readFileSync(path.join(root, 'src', 'payments', 'paypal.js'), 'utf8');
    expect(paypalSource.includes("checkoutIntents.completeVerifiedProvider('paypal',subscription.id,'completed')"), 'PayPal subscription activation must self-complete its own checkout intent.');
    const onboardingSource = fs.readFileSync(path.join(root, 'views', 'customer', 'onboarding.ejs'), 'utf8');
    expect(onboardingSource.includes('openCheckout'), 'the onboarding page must surface a stuck open checkout to the customer.');
    expect(capacitySource.includes('provider_terminal_at IS NULL')&&capacitySource.includes('capacity_hold_until'), 'capacity queries must retain attached locally-terminal checkouts until provider truth or backstop.');

    console.log('Checkout abandonment, provider-truth capacity retention, and Stripe confirmed-return smoke test passed.');
}

async function expectReject(fn, pattern) {
    let error = null;
    try { await fn(); } catch (e) { error = e; }
    if (!error) throw new Error('Expected operation to fail.');
    if (pattern && !pattern.test(String(error.message || error))) throw error;
}

main().finally(() => getPool().end());
