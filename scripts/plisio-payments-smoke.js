'use strict';

const fs=require('fs');
const path=require('path');
const plisio=require('../src/payments/plisio');
function expect(v,m){if(!v)throw new Error(m);}
function source(f){return fs.readFileSync(path.join(__dirname,'..',f),'utf8');}

expect(plisio.API_BASE==='https://api.plisio.net','Plisio must use the documented API host.');
expect(plisio.moneyMinor('12.34')===1234,'Plisio source amount conversion must preserve minor units.');
expect(plisio.moneyMinor('bad')===null,'Invalid Plisio amount must fail verification.');
const key='merchant-secret-for-smoke';
const payload={txn_id:'txn-1',order_number:'intent-1',status:'completed',source_currency:'GBP',source_amount:'6.00'};
const digest=plisio.callbackDigest(key,payload);
expect(/^[0-9a-f]{40}$/.test(digest),'Plisio verify_hash must be HMAC-SHA1 hex.');
const signed={...payload,verify_hash:digest};
expect(plisio.callbackDigest(key,signed)===digest,'verify_hash must be excluded from Plisio callback digest.');
expect(plisio.safeEqual(digest,digest)&&!plisio.safeEqual(digest,'0'.repeat(40)),'Plisio signature comparison must be timing-safe and reject mismatches.');
const parsed=plisio.parseCallback(Buffer.from(JSON.stringify(signed)),'application/json');
expect(parsed.txn_id==='txn-1','Plisio JSON callback parsing failed.');
let rejected=false;try{plisio.parseCallback(Buffer.from('txn_id=x'),'application/x-www-form-urlencoded');}catch(_){rejected=true;}expect(rejected,'Plisio callbacks must require JSON mode so signed serialization is deterministic.');

const moduleSource=source('src/payments/plisio.js');
expect(moduleSource.includes("'/api/v1/invoices/new'"),'Plisio checkout must use invoices/new.');
expect(moduleSource.includes('source_currency')&&moduleSource.includes('source_amount'),'Plisio checkout must anchor invoices to the local fiat contract.');
expect(moduleSource.includes("callback.searchParams.set('json', 'true')"),'Plisio callback must request JSON mode.');
expect(moduleSource.includes('getOperation(providerId)'),'Plisio callback must independently fetch the remote operation.');
expect(moduleSource.includes('verifiedProviderContract'),'Plisio completion must verify amount/currency against immutable local checkout terms.');
expect(moduleSource.includes("fields.status === 'completed'"),'Only completed Plisio operations may activate access.');
expect(moduleSource.includes('timingSafeEqual'),'Plisio callback comparison must use timingSafeEqual.');

const settings=source('src/payments/provider-settings.js');
expect(settings.includes("'plisio'"),'Plisio must be registered in provider settings.');
expect(settings.includes('PLISIO_SECRET_KEY'),'Plisio must support unattended environment fallback.');
expect(settings.includes('/api/v1/currencies'),'Plisio connection test must use a read-only provider endpoint.');

const checkout=source('src/platform/flexible-checkout.js');
expect(checkout.includes("'/account/checkout/plisio'"),'Customer Plisio checkout route is missing.');
expect(checkout.includes("'/webhooks/plisio'"),'Plisio invoice creation must use the public callback route.');
expect(checkout.includes("'/account/plisio/return'"),'Plisio return route must be included in invoice creation.');
expect(checkout.includes("wantsCredit&&provider==='plisio'"),'Plisio must reject mixed service-credit checkout while crypto confirmation can be delayed.');
expect(!checkout.includes("router.post('/account/checkout/coingate'"),'CoinGate must not remain available as a new customer checkout route.');

const webhook=source('src/platform/webhooks.js');
expect(webhook.includes("'/webhooks/plisio'"),'Plisio webhook route is missing.');
expect(webhook.includes("'/webhooks/coingate'"),'Legacy CoinGate webhook must remain for previously-created orders.');
const returns=source('src/platform/customer-payment-return.js');
expect(returns.includes("'/account/plisio/return'"),'Plisio browser return handler is missing.');
expect(returns.includes("'/account/coingate/return'"),'Legacy CoinGate return must remain for in-flight historical orders.');

const migration=source('db/migrations/033_plisio_payment_provider.sql');
for(const constraint of ['payment_provider_credentials_provider_check','billing_checkout_intents_provider_check','payment_events_provider_check','payment_incidents_provider_check','subscriptions_source_check'])expect(migration.includes(constraint),`Plisio migration is missing ${constraint}.`);
expect(migration.includes("'plisio'::text")&&migration.includes("'coingate'::text"),'Migration must add Plisio without invalidating historical CoinGate records.');

for(const view of ['views/customer/onboarding.ejs','views/customer/dashboard.ejs','views/customer/stremio-dashboard.ejs']){const html=source(view);expect(html.includes('/account/checkout/plisio'),`${view} does not expose Plisio checkout.`);expect(!html.includes('/account/checkout/coingate'),`${view} still exposes CoinGate to new customers.`);}
const admin=source('src/platform/admin-payment-settings.js');
expect(admin.includes('Plisio merchant API settings')&&admin.includes('SECRET_KEY'),'Admin Payments must explain Plisio setup.');
expect(admin.includes('Historical CoinGate'),'Admin Payments must preserve explicit legacy CoinGate visibility.');

console.log('Plisio payment integration smoke test passed.');
