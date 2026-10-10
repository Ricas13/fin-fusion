'use strict';

const fs=require('fs');
const path=require('path');
const plisio=require('../src/payments/plisio');
function expect(v,m){if(!v)throw new Error(m);}
function source(f){return fs.readFileSync(path.join(__dirname,'..',f),'utf8');}

expect(plisio.API_BASE==='https://api.plisio.net','Plisio must use the documented API host.');
expect(plisio.moneyMinor('12.34')===1234,'Plisio source amount conversion must preserve minor units.');
expect(plisio.moneyMinor('bad')===null,'Invalid Plisio amount must fail verification.');

const merchantPays=plisio.feeAccounting({
    sourceAmount:'10.00',sourceRate:'0.0001',
    actualSum:'0.001',actualCommission:'0.00001',actualFee:'0',actualInvoiceSum:'0.00099'
});
expect(merchantPays.feeDataAvailable&&merchantPays.feeMinor===10&&merchantPays.netMinor===990,'Merchant-paid Plisio commission must reduce net proceeds by the exact settled fee.');

const customerPays=plisio.feeAccounting({
    sourceAmount:'10.00',sourceRate:'0.0001',
    actualSum:'0.00101',actualCommission:'0.00001',actualFee:'0',actualInvoiceSum:'0.001'
});
expect(customerPays.feeDataAvailable&&customerPays.feeMinor===0&&customerPays.netMinor===1000,'Customer-paid Plisio commission must be known exact fee data without reducing merchant sale proceeds.');

const settledFee=plisio.feeAccounting({
    sourceAmount:'10.00',sourceRate:'0.0001',
    actualSum:'0.00101',actualCommission:'0.00001',actualFee:'0.00002',actualInvoiceSum:'0.00098'
});
expect(settledFee.feeDataAvailable&&settledFee.feeMinor===20&&settledFee.source==='actual_invoice_sum','Exact settled Plisio proceeds must include final network fee impact.');

const reconstructed=plisio.feeAccounting({
    sourceAmount:'10.00',sourceRate:'0.0001',
    actualSum:'0.00101',actualCommission:'0.00001',actualFee:'0.00002'
});
expect(reconstructed.feeDataAvailable&&reconstructed.feeMinor===20&&reconstructed.source==='actual_components','Exact actual Plisio components must reconstruct merchant proceeds when actual_invoice_sum is omitted.');

const quotedOnly=plisio.feeAccounting({
    sourceAmount:'10.00',sourceRate:'0.0001',invoiceAmount:'0.001',
    invoiceCommission:'0.00001',invoiceSum:'0.00099',invoiceTotalSum:'0.001'
});
expect(!quotedOnly.feeDataAvailable&&quotedOnly.feeMinor===0,'Quoted Plisio invoice commission must not be treated as exact final fee because network settlement fees can still differ.');

// Real production data: Plisio's callback rate is crypto per fiat (0.00001293 BTC per USD), but the
// operations API reports the inverse (USD per BTC). Both must give the same exact answer; the
// inverse used to produce "fee $3.00, net $0.00" on a $3.00 payment.
const callbackRate=plisio.feeAccounting({sourceAmount:'3.00',sourceRate:'0.00001293',actualSum:'0.00003879',actualCommission:'0.00000019',actualFee:'0',actualInvoiceSum:'0.00003860'},{grossMinor:300});
expect(callbackRate.feeDataAvailable&&callbackRate.feeMinor===1&&callbackRate.netMinor===299,'Callback-oriented rate must give a 1 cent fee on the real $3.00 payment.');
const apiRate=plisio.feeAccounting({sourceAmount:'3.00',sourceRate:String(1/0.00001293),actualSum:'0.00003879',actualCommission:'0.00000019',actualFee:'0',actualInvoiceSum:'0.00003860'},{grossMinor:300});
expect(apiRate.feeDataAvailable&&apiRate.feeMinor===1&&apiRate.netMinor===299,'An inverted (fiat per crypto) rate must be detected and give the same result, not net $0.00.');
const implausibleRate=plisio.feeAccounting({sourceAmount:'3.00',sourceRate:'5',actualSum:'0.00003879',actualInvoiceSum:'0.00003860'},{grossMinor:300});
expect(!implausibleRate.feeDataAvailable&&implausibleRate.netMinor===300,'A rate that matches neither orientation must not be guessed.');

const unknownFee=plisio.feeAccounting({sourceAmount:'10.00'});
expect(!unknownFee.feeDataAvailable&&unknownFee.feeMinor===0&&unknownFee.netMinor===1000,'Missing Plisio fee evidence must stay explicitly incomplete instead of guessing a fee.');

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

expect(plisio.storedEventProviderId({provider_event_id:'operation:txn-fallback:expired:legacy'}, {})==='txn-fallback','Stored Plisio recovery must recover the provider transaction from the durable event ID.');
expect(plisio.storedEventProviderId({provider_event_id:'operation:txn-fallback:expired:legacy'}, {txn_id:'txn-payload'})==='txn-payload','Stored Plisio recovery must prefer the persisted payload transaction ID when present.');

const historicalIntent={id:'intent-historical',provider_checkout_id:'txn-historical'};
const authenticatedHistoricalPayload={txn_id:'txn-historical',order_number:'intent-historical',status:'new',source_amount:'6.00',source_currency:'GBP',verify_hash:'persisted-authenticated-evidence'};
expect(plisio.storedIntentEvidenceMatches(authenticatedHistoricalPayload,historicalIntent,'txn-historical'),'Stored Plisio evidence must exactly bind provider transaction to local checkout intent.');
expect(plisio.storedEventIntentMatches({id:'txn-historical',orderNumber:'',status:'cancelled'},authenticatedHistoricalPayload,historicalIntent,'txn-historical'),'Terminal unpaid Plisio recovery may use exact authenticated stored identity when the current provider response omits order_number.');
expect(plisio.storedEventIntentMatches({id:'txn-historical',orderNumber:'',status:'completed'},authenticatedHistoricalPayload,historicalIntent,'txn-historical'),'Completed Plisio payments may recover identity from exact authenticated callback evidence when the merchant API omits order_number.');
expect(!plisio.storedEventIntentMatches({id:'txn-historical',orderNumber:'',status:'completed'},{...authenticatedHistoricalPayload,source_amount:null,source_currency:''},historicalIntent,'txn-historical'),'Completed Plisio recovery must fail closed when authenticated fiat evidence is incomplete.');
expect(!plisio.storedEventIntentMatches({id:'txn-historical',orderNumber:'',status:'pending'},authenticatedHistoricalPayload,historicalIntent,'txn-historical'),'Waiting Plisio payments must never use historical identity fallback when current provider order_number is missing.');
expect(!plisio.storedEventIntentMatches({id:'txn-historical',orderNumber:'',status:'cancelled'},{...authenticatedHistoricalPayload,order_number:'wrong-intent'},historicalIntent,'txn-historical'),'Terminal fallback must reject a stored callback that names another checkout intent.');
expect(!plisio.storedEventIntentMatches({id:'txn-historical',orderNumber:'other-intent',status:'cancelled'},authenticatedHistoricalPayload,historicalIntent,'txn-historical'),'A non-empty current provider order_number mismatch must remain authoritative and be rejected.');
expect(!plisio.storedEventIntentMatches({id:'txn-historical',orderNumber:'',status:'cancelled'},authenticatedHistoricalPayload,{...historicalIntent,provider_checkout_id:'another-txn'},'txn-historical'),'Terminal fallback must reject a checkout no longer bound to the provider transaction.');

const moduleSource=source('src/payments/plisio.js');
expect(moduleSource.includes("require('./provider-financial-state')"),'Plisio completion must write through canonical provider financial state.');
expect(moduleSource.includes('feeAccounting(fields')&&moduleSource.includes('feeDataAvailable:accounting.feeDataAvailable'),'Completed Plisio payments must persist verified fee completeness instead of hardcoding zero-fee accounting.');
expect(moduleSource.includes('syncFeeData')&&moduleSource.includes('latestPlisioCallbackEvidence'),'Historical Plisio fee reconciliation must combine authenticated operation truth with previously processed callback evidence.');
expect(moduleSource.includes("'/api/v1/invoices/new'"),'Plisio checkout must use invoices/new.');
expect(moduleSource.includes('source_currency')&&moduleSource.includes('source_amount'),'Plisio checkout must anchor invoices to the local fiat contract.');
expect(moduleSource.includes("callback.searchParams.set('json', 'true')"),'Plisio callback must request JSON mode.');
expect(moduleSource.includes('getOperation(providerId)'),'Plisio callback must independently fetch the remote operation.');
expect(moduleSource.includes('verifiedProviderContract'),'Plisio completion must verify amount/currency against immutable local checkout terms.');
expect(moduleSource.includes('financialState.recordTransaction'),'Verified Plisio completion must enter the canonical provider financial ledger.');
expect(moduleSource.includes("fields.status === 'completed'"),'Only completed Plisio operations may activate access.');
expect(moduleSource.includes('timingSafeEqual'),'Plisio callback comparison must use timingSafeEqual.');
expect(!moduleSource.includes('.sort('),'Plisio callback signing must not reorder JSON keys before JSON.stringify.');
expect(moduleSource.includes("findProviderIntent('plisio', providerId)"),'Historical Plisio event recovery must bind provider truth to the stored local checkout identity.');
expect(moduleSource.includes('TERMINAL_UNPAID_STATUSES.has(fields.status)'),'Historical terminal unpaid Plisio events must be safely closable after provider re-verification.');
expect(moduleSource.includes('Completed Plisio transaction has no local checkout intent and requires manual reconciliation.'),'Orphan completed Plisio revenue must remain operator-visible rather than being discarded.');
const retrySource=moduleSource.match(/async function retryPaymentEvent\([\s\S]*?\n\}/)?.[0]||'';
expect(retrySource.includes('reconcileStoredPaymentEvent(eventRow, payload)'),'Durable Plisio retries must recover from authenticated merchant API truth.');
expect(!retrySource.includes('authenticateCallback'),'Durable Plisio retries must not permanently depend on a historical callback signature.');

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
const ledgerMigration=source('db/migrations/20261002090000_unify_provider_financial_ledger.sql');
expect(ledgerMigration.includes("provider IN ('stripe','paypal','plisio')"),'Canonical provider ledger must accept Plisio transactions.');

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