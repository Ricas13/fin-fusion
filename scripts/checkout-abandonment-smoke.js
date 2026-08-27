'use strict';

require('dotenv').config();
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('Checkout abandonment self-service smoke')) process.exit(0);

const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const intents = require('../src/payments/checkout-intents');
const fs = require('fs');
const path = require('path');

function expect(condition, message) { if (!condition) throw new Error(message); }

async function main() {
    const suffix = crypto.randomBytes(4).toString('hex');
    const customer = (await query(`INSERT INTO customers(display_name,email) VALUES('Abandon Test',$1) RETURNING id`, [`abandon-${suffix}@example.invalid`])).rows[0];

    const created = await intents.createIntent({ scope: 'customer', customerId: customer.id, provider: 'paypal', checkoutMode: 'payment', commercialSnapshot: {} });

    // Starting a second checkout while the first is open must still be refused --
    // this smoke exists to check that customers now have a way OUT of that state.
    await expectReject(() => intents.createIntent({ scope: 'customer', customerId: customer.id, provider: 'stripe', checkoutMode: 'payment', commercialSnapshot: {} }), /already in progress/i);

    const open = await intents.getOpenForOwner('customer', customer.id);
    expect(open && open.id === created.id, 'getOpenForOwner must find the customer\'s own stuck checkout intent.');

    const cancelledCount = await intents.cancelForOwner('customer', customer.id);
    expect(cancelledCount === 1, 'cancelForOwner must cancel exactly the customer\'s own open intent.');

    const afterCancel = await intents.getOpenForOwner('customer', customer.id);
    expect(afterCancel === null, 'no open intent should remain after cancellation.');

    // Now starting a new checkout must succeed, proving the customer is unstuck.
    const retried = await intents.createIntent({ scope: 'customer', customerId: customer.id, provider: 'stripe', checkoutMode: 'payment', commercialSnapshot: {} });
    expect(retried && retried.id, 'customer must be able to start a fresh checkout after cancelling the stuck one.');

    const root = path.join(__dirname, '..');
    const routeSource = fs.readFileSync(path.join(root, 'src', 'platform', 'flexible-checkout.js'), 'utf8');
    const returnSource = fs.readFileSync(path.join(root, 'src', 'platform', 'customer-payment-return.js'), 'utf8');
    const webhookSource = fs.readFileSync(path.join(root, 'src', 'platform', 'webhooks.js'), 'utf8');
    const stripeSource = fs.readFileSync(path.join(root, 'src', 'payments', 'stripe.js'), 'utf8');
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
    const onboardingSource = fs.readFileSync(path.join(root, 'views', 'customer', 'onboarding.ejs'), 'utf8');
    expect(onboardingSource.includes('openCheckout'), 'the onboarding page must surface a stuck open checkout to the customer.');

    console.log('Checkout abandonment and Stripe confirmed-return smoke test passed.');
}

async function expectReject(fn, pattern) {
    let error = null;
    try { await fn(); } catch (e) { error = e; }
    if (!error) throw new Error('Expected operation to fail.');
    if (pattern && !pattern.test(String(error.message || error))) throw error;
}

main().finally(() => getPool().end());
