'use strict';

const fs = require('fs');
const path = require('path');
const coingate = require('../src/payments/coingate');

function expect(condition, message) {
    if (!condition) throw new Error(message);
}
function source(relative) {
    return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

const secret = 'a'.repeat(64);
const first = coingate.callbackTokenFor(secret, 'intent-one');
const second = coingate.callbackTokenFor(secret, 'intent-two');
expect(/^[0-9a-f]{64}$/.test(first), 'CoinGate callback HMAC must be a SHA-256 hex digest.');
expect(first !== second, 'CoinGate callback HMAC must be bound to the checkout intent.');
expect(coingate.callbackTokenFor(secret, 'intent-one') === first, 'CoinGate callback HMAC must be stable for retry verification.');
expect(coingate.baseUrl({ environment: 'sandbox' }) === 'https://api-sandbox.coingate.com', 'CoinGate sandbox host changed unexpectedly.');
expect(coingate.baseUrl({ environment: 'live' }) === 'https://api.coingate.com', 'CoinGate live host changed unexpectedly.');
expect(coingate.moneyMinor('12.34') === 1234, 'CoinGate fiat amount conversion must preserve minor units.');
expect(coingate.moneyMinor('not-money') === null, 'Invalid CoinGate amount must not verify.');

const jsonPayload = coingate.parseCallback(Buffer.from('{"id":123,"order_id":"abc","status":"paid","token":"xyz"}'), 'application/json');
expect(String(jsonPayload.id) === '123' && jsonPayload.status === 'paid', 'CoinGate JSON callback parsing failed.');
const formPayload = coingate.parseCallback(Buffer.from('id=123&order_id=abc&status=paid&token=xyz'), 'application/x-www-form-urlencoded');
expect(formPayload.order_id === 'abc' && formPayload.token === 'xyz', 'CoinGate form callback parsing failed.');

const moduleSource = source('src/payments/coingate.js');
expect(moduleSource.includes("Authorization: `Token ${cfg.apiToken}`"), 'CoinGate API calls must use Token authorization, not Bearer.');
expect(moduleSource.includes("api('/api/v2/orders'"), 'CoinGate checkout must create a v2 order.');
expect(moduleSource.includes('getOrder(providerId)'), 'CoinGate callbacks must re-fetch the provider order before fulfilment.');
expect(moduleSource.includes('verifiedProviderContract'), 'CoinGate fulfilment must verify the immutable local checkout contract.');
expect(moduleSource.includes('timingSafeEqual'), 'CoinGate callback verifier must use timing-safe comparison.');

const providerSource = source('src/payments/provider-settings.js');
expect(providerSource.includes("'coingate'"), 'CoinGate must be registered as a payment provider.');
expect(providerSource.includes('/v2/auth/test'), 'CoinGate connection test must use the provider auth endpoint.');
expect(providerSource.includes('crypto.randomBytes(32)'), 'Browser-managed CoinGate setup must generate a private callback verifier.');

const checkoutSource = source('src/platform/flexible-checkout.js');
expect(checkoutSource.includes("'/account/checkout/coingate'"), 'Customer CoinGate checkout route is missing.');
expect(checkoutSource.includes("'/webhooks/coingate'"), 'CoinGate order creation must use the public callback route.');
expect(checkoutSource.includes("'/account/coingate/return'"), 'CoinGate browser return route must be included in order creation.');
expect(checkoutSource.includes("wantsCredit&&provider==='coingate'"), 'CoinGate must reject mixed service-credit checkout so an expiring credit reservation cannot be double-spent while crypto confirms.');
expect(checkoutSource.includes("ttlMinutes:provider==='coingate'?180:60"), 'CoinGate checkout intents must preserve the hosted checkout for the extended crypto payment window.');
expect(checkoutSource.includes("ttlMinutes:provider==='coingate'?180:30"), 'CoinGate discount reservations must follow the extended crypto checkout window.');
const intentsSource = source('src/payments/checkout-intents.js');
expect(intentsSource.includes("maxTtl=provider==='coingate'?180:60"), 'Checkout intents must allow CoinGate extended TTL without changing other providers.');
const discountSource = source('src/payments/discounts.js');
expect(discountSource.includes('Math.min(180,Number(ttlMinutes)||30)'), 'Discount reservations must support the CoinGate extended TTL.');
const webhookSource = source('src/platform/webhooks.js');
expect(webhookSource.includes("'/webhooks/coingate'"), 'CoinGate webhook route is missing.');
expect(webhookSource.includes("express.raw({type:'*/*'"), 'CoinGate callback route must preserve raw JSON/form payloads.');
const returnSource = source('src/platform/customer-payment-return.js');
expect(returnSource.includes("'/account/coingate/return'"), 'CoinGate customer return handler is missing.');
expect(returnSource.includes("provider:'coingate'"), 'CoinGate return must verify checkout ownership and provider state.');

const migration = source('db/migrations/032_coingate_payment_provider.sql');
for (const constraint of ['payment_provider_credentials_provider_check','billing_checkout_intents_provider_check','payment_events_provider_check','payment_incidents_provider_check','subscriptions_source_check']) {
    expect(migration.includes(constraint), `CoinGate migration is missing ${constraint}.`);
}
expect(migration.includes("'coingate'::text"), 'CoinGate migration must add the provider to database constraints.');

const cryptoViews = {
    'views/customer/onboarding.ejs': 'CoinGate · One-off payment',
    'views/customer/dashboard.ejs': 'Pay with crypto',
    'views/customer/stremio-dashboard.ejs': 'Pay with crypto'
};
for (const [view, label] of Object.entries(cryptoViews)) {
    const html = source(view);
    expect(html.includes('/account/checkout/coingate'), `${view} does not expose CoinGate checkout.`);
    expect(html.includes(label), `${view} does not label the crypto checkout clearly.`);
}

const admin = source('src/platform/admin-payment-settings.js');
expect(admin.includes('CoinGate API App token'), 'Admin payments page must explain the CoinGate API token.');
expect(admin.includes('one-time crypto checkout'), 'Admin payments page must explain CoinGate renewal semantics.');

console.log('CoinGate payment integration smoke test passed.');