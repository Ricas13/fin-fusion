'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const customerHistory = require('../src/platform/customer-history');

const root = path.join(__dirname, '..');
const historySource = fs.readFileSync(path.join(root, 'src/platform/customer-history.js'), 'utf8');
const transactionBrowserSource = fs.readFileSync(path.join(root, 'src/payments/transaction-browser.js'), 'utf8');
const financialStateSource = fs.readFileSync(path.join(root, 'src/payments/provider-financial-state.js'), 'utf8');
const adminCompactSource = fs.readFileSync(path.join(root, 'src/platform/customer-360-compact.js'), 'utf8');

const sample = {
  provider: 'paypal',
  provider_transaction_id: '51469559GP3271839',
  provider_reference_id: 'I-2EK4NRSN93VR',
  occurred_at: '2026-10-05T11:06:48Z',
  transaction_status: 'S',
  gross_amount_minor: 3000,
  currency: 'USD',
  kind: 'payment'
};

const html = customerHistory.transactionsCard({ rows: [sample], total: 1, hasNext: false });
assert(html.includes('51469559GP3271839'), 'customer Payments must show the exact provider transaction ID');
assert(html.includes('I-2EK4NRSN93VR'), 'customer Payments may expose the provider reference used to correlate the payment');
assert(html.includes('$30.00') || html.includes('US$30.00'), 'customer Payments must show the canonical ledger amount');
assert(html.includes('PayPal'), 'customer Payments must show the provider from the canonical ledger');

assert(
  historySource.includes("require('../payments/transaction-browser')") &&
  historySource.includes('transactionBrowser.customerTransactions(req.session.customerId)'),
  'customer Payments must read through the canonical transaction browser'
);
assert(
  transactionBrowserSource.includes("require('./provider-financial-state')") &&
  transactionBrowserSource.includes('financialState.queryTransactions'),
  'the transaction browser must read canonical provider financial state'
);
assert(
  financialStateSource.includes('FROM payment_history_transactions t'),
  'canonical provider financial state must read payment_history_transactions'
);
assert(
  adminCompactSource.includes('financialState.customerSnapshot(customerId)'),
  'admin Customer 360 Payments must read the same canonical provider financial state'
);
assert(
  adminCompactSource.includes('row.provider_transaction_id'),
  'admin Customer 360 Payments must expose canonical provider transaction IDs'
);
assert(
  !/FROM\s+subscriptions[\s\S]{0,300}Payment transactions/i.test(historySource),
  'customer payment history must never synthesize payments from entitlement rows'
);

console.log('customer/admin canonical payment surface smoke: ok');
