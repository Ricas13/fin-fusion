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
const jobs=read('src/automation/jobs.js');

assert(state.includes('FROM payment_history_transactions')&&state.includes('INSERT INTO payment_history_transactions'),
  'provider-financial-state must own canonical provider ledger reads/writes');
for(const [name,source] of [
  ['transaction browser',browser],
  ['Customer 360',compact],
  ['commerce dashboard ledger',dashboard],
  ['data export',dataExport]
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

console.log('provider financial state centralization smoke: ok');
