'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const classifier = require('../src/payments/provider-transaction-classifier');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '20260905120000_legacy_payment_history_bridge.sql'),
  'utf8'
);

assert(migration.includes('FROM legacy_subscription_imports'), 'existing legacy paid imports must be backfilled into Payment History');
assert(migration.includes("WHERE lsi.provider IN ('stripe','paypal')"), 'only real Stripe/PayPal legacy transactions may enter provider history');
assert(migration.includes("WHEN 'stripe' THEN 'charge'"), 'legacy Stripe payments must use the canonical accounting payment category');
assert(migration.includes("ELSE 'T0006'"), 'legacy PayPal payments must use a canonical successful payment code');
assert(migration.includes("ELSE 'S'"), 'legacy PayPal payments must be marked successful for canonical accounting classification');
assert(migration.includes('AFTER INSERT ON legacy_subscription_imports'), 'future legacy paid imports must be mirrored in the same database transaction');
assert(migration.includes('ON CONFLICT(provider,provider_transaction_id) DO NOTHING'), 'backfill must not overwrite authoritative provider-history rows');
assert(migration.includes('customer_id=COALESCE(pht.customer_id,lsi.customer_id)'), 'existing provider-history rows may only gain a missing customer link during backfill');
assert(migration.includes('customer_id=COALESCE(payment_history_transactions.customer_id,NEW.customer_id)'), 'trigger conflicts may only fill a missing customer link');
assert(!/INSERT\s+INTO\s+payment_history_import_runs/i.test(migration), 'legacy CSV rows must never claim comprehensive provider-history coverage');
assert(!/\bUPDATE\s+subscriptions\b/i.test(migration), 'accounting bridge must never alter entitlement state');
assert(!/\bINSERT\s+INTO\s+subscriptions\b/i.test(migration), 'accounting bridge must never create entitlement state');

assert.strictEqual(
  classifier.classifyProviderTransaction({ provider: 'stripe', type: 'charge', status: 'available', grossMinor: 1000 }),
  'payment',
  'synthetic legacy Stripe category must be recognized by the canonical classifier'
);
assert.strictEqual(
  classifier.classifyProviderTransaction({ provider: 'paypal', type: 'T0006', status: 'S', grossMinor: 1000 }),
  'payment',
  'synthetic legacy PayPal category must be recognized by the canonical classifier'
);

console.log('legacy payment history bridge smoke: ok');
