'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const settings=read('src/payments/provider-settings.js');
const checkout=read('src/platform/flexible-checkout.js');
const browser=read('public/js/customer-checkout.js');

assert(settings.includes('function checkoutReady(provider,cfg)'), 'provider settings must define a canonical checkout-readiness predicate');
assert(settings.includes('configured(provider,cfg)&&webhookConfigured(provider,cfg)'), 'checkout readiness must require enabled credentials plus callback/webhook configuration');
assert(settings.includes("restricted=/^rk_/i.test(key)"), 'Stripe diagnostics must recognize restricted keys');
assert(settings.includes('does not prove the Customer, Checkout Session or Coupon write permissions'), 'Stripe read probe must not claim to verify checkout write permissions');
assert(checkout.includes('await assertProviderCheckoutReady(provider);'), 'checkout start must enforce provider readiness on the server');
assert(checkout.includes("router.get('/account/checkout/readiness',requireCustomer"), 'readiness endpoint must require customer authentication');
assert(checkout.indexOf('await assertProviderCheckoutReady(provider);')<checkout.indexOf('const intent=await intents.createIntent'), 'provider readiness must be enforced before a checkout intent is created');
assert(browser.includes("fetch('/account/checkout/readiness'"), 'customer checkout UI must consume readiness state');
assert(browser.includes('button.disabled=true'), 'unavailable provider controls must be disabled client-side as well as hidden');

console.log('provider checkout readiness static smoke: ok');
