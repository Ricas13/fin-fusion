'use strict';

const fs=require('fs');
const path=require('path');
const plisio=require('../src/payments/plisio');
function expect(v,m){if(!v)throw new Error(m);}
function source(f){return fs.readFileSync(path.join(__dirname,'..',f),'utf8');}

expect(plisio.API_BASE==='https://api.plisio.net','Plisio must use the documented API host.');
expect(plisio.moneyMinor('12.34')===1234,'Plisio source amount conversion must preserve minor units.');
expect(plisio.moneyMinor('bad')===null,'Invalid Plisio amount must fail verification.');

// Plisio's callback protocol signs JSON.stringify(parsedJsonWithoutVerifyHash)
// with HMAC-SHA1. Pin a literal vector so this test proves serialization and
// key-order behavior instead of calculating its own expected value at runtime.
const key='merchant-secret-for-smoke';
const payload={txn_id:'txn-1',order_number:'intent-1',status:'completed',source_currency:'GBP',source_amount:'6.00'};
const protocolDigest='4ca68d28b4ee3a3ad231f9aa1293ebeb41b998b5';
const digest=plisio.callbackDigest(key,payload);
expect(digest===protocolDigest,'Plisio callback digest must match the pinned JSON/HMAC-SHA1 protocol vector.');
const signed={...payload,verify_hash:protocolDigest};
expect(plisio.callbackDigest(key,signed)===protocolDigest,'verify_hash must be excluded from Plisio callback digest.');
expect(plisio.safeEqual(protocolDigest,protocolDigest)&&!plisio.safeEqual(protocolDigest,'0'.repeat(40)),'Plisio signature comparison must be timing-safe and reject mismatches.');
const reordered={status:'completed',txn_id:'txn-1',order_number:'intent-1',source_currency:'GBP',source_amount:'6.00'};
expect(plisio.callbackDigest(key,reordered)!==protocolDigest,'Plisio callback verification must preserve parsed JSON key order and must not silently sort callback keys.');
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
expect(!moduleSource.includes('.sort('),'Plisio callback signing must not reorder JSON keys before JSON.stringify.');

const settings=source('src/payments/provider-settings.js');
expect(settings.includes("const PROVIDERS = ['stripe', 'paypal', 'plisio']"),'Provider settings must contain only the supported gateways.');
expect(settings.includes('PLISIO_SECRET_KEY'),'Plisio must support unattended environment fallback.');
expect(settings.includes('/api/v1/currencies'),'Plisio connection test must use a read-only provider endpoint.');

const checkout=source('src/platform/flexible-checkout.js');
expect(checkout.includes("'/account/checkout/plisio'"),'Customer Plisio checkout route is missing.');
expect(checkout.includes("'/webhooks/plisio'"),'Plisio invoice creation must use the public callback route.');
expect(checkout.includes("'/account/plisio/return'"),'Plisio return route must be included in invoice creation.');
expect(checkout.includes("wantsCredit&&provider==='plisio'"),'Plisio must reject mixed service-credit checkout while crypto confirmation can be delayed.');

const webhook=source('src/platform/webhooks.js');
expect(webhook.includes("'/webhooks/plisio'"),'Plisio webhook route is missing.');
const webhookRoutes=[...webhook.matchAll(/router\.post\('([^']+)'/g)].map(match=>match[1]).filter(route=>route.startsWith('/webhooks/'));
const paymentWebhookRoutes=webhookRoutes.filter(route=>['/webhooks/stripe','/webhooks/paypal','/webhooks/plisio'].includes(route));
expect(paymentWebhookRoutes.length===3,'Stripe, PayPal and Plisio webhook routes must remain mounted.');
expect(webhookRoutes.length===4&&webhookRoutes.includes('/webhooks/jellyfin/:serverId'),'Only the three payment webhooks and the Jellyfin playback telemetry webhook may be mounted.');
const returns=source('src/platform/customer-payment-return.js');
expect(returns.includes("'/account/plisio/return'"),'Plisio browser return handler is missing.');
const returnRoutes=returns.match(/\/account\/[^'\"]+\/return/g)||[];
expect(returnRoutes.length===3,'Only Stripe, PayPal and Plisio browser payment returns may be mounted.');
expect(returnRoutes.some(route=>route.includes('/stripe/return'))&&returns.includes('providerCheckoutId:sessionId')&&returns.includes('stripe.confirmCheckout(sessionId,row)'),'Stripe browser return must remain provider-confirmed and bound to the local Checkout Session.');

const migration=source('db/migrations/035_plisio_only_payment_provider.sql');
for(const constraint of ['payment_provider_credentials_provider_check','billing_checkout_intents_provider_check','payment_events_provider_check','payment_incidents_provider_check','subscriptions_source_check'])expect(migration.includes(constraint),`Plisio migration is missing ${constraint}.`);
expect(migration.includes("'plisio'::text")&&migration.includes("'legacy_crypto'::text"),'Migration must keep Plisio active while neutralising unsupported historical crypto records.');

// Plisio checkout is exposed on the two live customer plan surfaces. The old
// standalone Stremio dashboard was retired when Stremio management moved Home.
for(const view of ['views/customer/onboarding.ejs','views/customer/dashboard.ejs']){const html=source(view);expect(html.includes('/account/checkout/plisio'),`${view} does not expose Plisio checkout.`);}
expect(!fs.existsSync(path.join(__dirname,'..','views/customer/stremio-dashboard.ejs')),'Retired standalone Stremio dashboard must stay removed.');
const admin=source('src/platform/admin-payment-settings.js');
expect(admin.includes('Plisio merchant API settings')&&admin.includes('SECRET_KEY'),'Admin Payments must explain Plisio setup.');
expect(admin.includes('Legacy crypto'),'Admin Payments must present unsupported historical crypto records neutrally.');

const history=source('src/platform/customer-history.js');
expect(/billingLabel\(value\)\{return\(\{[^}]*plisio:'Plisio'/.test(history),'Customer billing history must label Plisio payments instead of showing the raw provider key.');
expect(/providerLabel\(value\)\{return value==='stripe'\?'Stripe':value==='paypal'\?'PayPal':value==='plisio'\?'Plisio'/.test(history),'Customer transaction history must label Plisio transactions instead of showing the raw provider key.');

console.log('Plisio payment integration smoke test passed.');
