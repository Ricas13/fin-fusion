'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');

const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const state=read('src/payments/provider-financial-state.js');
const browser=read('src/payments/transaction-browser.js');
const compact=read('src/platform/customer-360-compact.js');
const dashboard=read('src/payments/dashboard-ledger.js');
const dataExport=read('src/payments/data-export.js');
const stripeHistory=read('src/payments/live-stripe-payment-history.js');
const reconciliation=read('src/payments/provider-financial-reconciliation.js');
const paypal=read('src/payments/paypal.js');
const accounting=read('src/payments/history-accounting.js');
const discovery=read('src/payments/subscription-discovery.js');
const manualLink=read('src/payments/manual-subscription-link.js');
const lifecyclePrimitives=read('src/payments/lifecycle-primitives.js');
const jobs=read('src/automation/jobs.js');

assert(state.includes('FROM payment_history_transactions')&&state.includes('INSERT INTO payment_history_transactions'),
  'provider-financial-state must own canonical provider ledger reads/writes');
for(const [name,source] of [
  ['transaction browser',browser],
  ['Customer 360',compact],
  ['commerce dashboard ledger',dashboard],
  ['data export',dataExport],
  ['history accounting',accounting]
]){
  assert(source.includes('provider-financial-state'),`${name} must consume canonical provider financial state`);
  assert(!source.includes('FROM payment_history_transactions'),`${name} must not create a second direct provider-ledger reader`);
}
assert(browser.includes('financialState.queryTransactions')&&browser.includes('financialState.countTransactions'),
  'transaction browser must delegate query/count semantics to canonical state');
assert(compact.includes('financialState.customerSnapshot(customerId)'),
  'Customer 360 must use the canonical customer financial projection');
assert(dashboard.includes('financialState.scanTransactionsInRange'),
  'commerce accounting must stream canonical ledger rows through the central reader');
assert(dataExport.includes('financialState.exportTransactions')&&dataExport.includes('financialState.countTransactions'),
  'exports and export counts must use the same canonical transaction reader');
assert(accounting.includes('financialState.scanAllTransactions'),
  'stored accounting summaries must use the same canonical transaction reader');
assert(discovery.includes("financialState.providerIdentityRows(['stripe','paypal'])")&&discovery.includes('financialState.paypalSubscriptionReferences()'),
  'subscription discovery must reuse canonical provider identity and transaction-reference readers');
assert(manualLink.includes('financialState.providerIdentityOwners'),
  'manual provider-link verification must reuse canonical provider identity ownership');
assert(lifecyclePrimitives.includes('financialState.ensureProviderIdentity')&&lifecyclePrimitives.includes('financialState.findProviderIdentity'),
  'payment lifecycle customer-identity helpers must delegate to canonical provider financial state');
assert(dataExport.includes("provider === 'plisio' ? 'Plisio'"),
  'exports must preserve Plisio provider identity');

assert(state.includes("s.source<>'stripe'"),
  'provider-customer backfill must preserve PayPal payer fan-in and restrict collision protection to Stripe');
assert(state.includes('COUNT(DISTINCT customer_id) candidate_count'),
  'ownership repair must reject ambiguous customer evidence');
assert(state.includes('strong_summary')&&state.includes('weak_summary'),
  'ownership repair must prefer exact checkout/subscription/metadata evidence over weak provider-customer identity');
assert(state.includes('legacy_subscription_imports'),
  'legacy Stripe transaction identity must remain valid ownership evidence');
assert(stripeHistory.includes('financialState.resolveCustomerId'),
  'Stripe history catch-up must reuse canonical customer ownership resolution');
assert(paypal.includes('financialState.recordTransaction')&&paypal.includes('recordPaypalLivePayment')&&paypal.includes('recordPaypalLiveRefund'),
  'PayPal webhook payments and refunds must enter the canonical customer financial ledger');

assert(reconciliation.includes("liveStripeHistory.syncRecent")&&reconciliation.includes("syncRecentPayPalHistory")&&reconciliation.includes('reconcileLocalEvidence'),
  'unified reconciliation must converge Stripe, PayPal and local/Plisio evidence');
assert(jobs.includes('provider_financial_reconciliation:{defaultIntervalSeconds:300'),
  'unified provider financial reconciliation must remain scheduled every five minutes');
assert(compact.includes('Open Stripe ↗')&&compact.includes('provider_customer_id'),
  'Customer 360 must expose the provider identity needed for refund/support work');


function jsFiles(dir){
  const out=[];
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())out.push(...jsFiles(full));
    else if(entry.isFile()&&entry.name.endsWith('.js'))out.push(full);
  }
  return out;
}
const platformRawFinancial=jsFiles(path.join(root,'src','platform')).filter(file=>{
  const source=fs.readFileSync(file,'utf8');
  return /\b(?:payment_history_transactions|payment_customers)\b/.test(source);
}).map(file=>path.relative(root,file).replace(/\\/g,'/'));
assert.deepStrictEqual(platformRawFinancial,[],
  'platform/pages must never query provider transaction/customer-identity tables directly; use provider-financial-state or a canonical read-model wrapper');

const paymentTableUsers=jsFiles(path.join(root,'src','payments')).filter(file=>
  /\bpayment_history_transactions\b/.test(fs.readFileSync(file,'utf8'))
).map(file=>path.relative(path.join(root,'src','payments'),file).replace(/\\/g,'/')).sort();
assert.deepStrictEqual(paymentTableUsers,[
  'live-paypal-payment-history.js',
  'provider-checkout-recovery.js',
  'provider-financial-state.js'
].sort(),
  'new provider-ledger SQL readers/writers must go through provider-financial-state; remaining PayPal settlement import and exact checkout recovery are the only documented exceptions');

const paymentCustomerUsers=jsFiles(path.join(root,'src','payments')).filter(file=>
  /\bpayment_customers\b/.test(fs.readFileSync(file,'utf8'))
).map(file=>path.relative(path.join(root,'src','payments'),file).replace(/\\/g,'/')).sort();
assert.deepStrictEqual(paymentCustomerUsers,[
  'provider-financial-state.js'
],
  'provider-customer identity storage must have one canonical SQL owner; lifecycle code must delegate to it');

console.log('provider financial state centralization smoke: ok');
