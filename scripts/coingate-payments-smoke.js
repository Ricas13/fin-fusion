'use strict';

const fs=require('fs');
const path=require('path');
const coingate=require('../src/payments/coingate');
function expect(v,m){if(!v)throw new Error(m);}
function source(f){return fs.readFileSync(path.join(__dirname,'..',f),'utf8');}

// CoinGate is no longer offered for new checkout, but its verifier and callback
// path remain intact so orders created before the Plisio migration can finish.
const secret='a'.repeat(64),first=coingate.callbackTokenFor(secret,'intent-one');
expect(/^[0-9a-f]{64}$/.test(first),'Legacy CoinGate callback HMAC must remain SHA-256.');
expect(coingate.callbackTokenFor(secret,'intent-two')!==first,'Legacy CoinGate callback must remain intent-bound.');
expect(coingate.moneyMinor('12.34')===1234,'Legacy CoinGate amount verification changed unexpectedly.');
const moduleSource=source('src/payments/coingate.js');
expect(moduleSource.includes('getOrder(providerId)')&&moduleSource.includes('verifiedProviderContract'),'Legacy CoinGate callbacks must still re-fetch and verify provider orders.');
expect(moduleSource.includes('timingSafeEqual'),'Legacy CoinGate callback verification must remain timing-safe.');
const settings=source('src/payments/provider-settings.js');
expect(settings.includes("['stripe', 'paypal', 'coingate', 'plisio']"),'Provider settings must retain CoinGate only for historical compatibility while registering Plisio.');
const checkout=source('src/platform/flexible-checkout.js');
expect(!checkout.includes("router.post('/account/checkout/coingate'"),'New CoinGate checkout must stay retired.');
const webhooks=source('src/platform/webhooks.js');
expect(webhooks.includes("'/webhooks/coingate'"),'In-flight historical CoinGate callbacks must remain accepted.');
const returns=source('src/platform/customer-payment-return.js');
expect(returns.includes("'/account/coingate/return'"),'In-flight historical CoinGate browser returns must remain accepted.');
for(const view of ['views/customer/onboarding.ejs','views/customer/dashboard.ejs','views/customer/stremio-dashboard.ejs'])expect(!source(view).includes('/account/checkout/coingate'),`${view} must not advertise retired CoinGate checkout.`);
const migration=source('db/migrations/033_plisio_payment_provider.sql');
expect(migration.includes("'coingate'::text")&&migration.includes("'plisio'::text"),'Plisio migration must preserve historical CoinGate database rows.');
const admin=source('src/platform/admin-payment-settings.js');
expect(admin.includes('Historical CoinGate'),'Admin payment history must explain retained CoinGate records without exposing CoinGate as a new gateway.');
console.log('CoinGate legacy compatibility smoke test passed.');
