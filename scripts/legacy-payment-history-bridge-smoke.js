'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '20260915230000_repair_legacy_stripe_accounting.sql'),
  'utf8'
);

assert(migration.includes('legacyCsvSyntheticAccounting'));
assert(migration.includes('provider_reference_id=s.provider_transaction_id'));
assert(migration.includes('customer_id=COALESCE(r.customer_id,m.customer_id)'));
assert(migration.includes('DELETE FROM payment_history_transactions s'));
assert(migration.includes('AFTER INSERT ON legacy_subscription_imports'));
assert(migration.includes("IF NEW.provider='stripe' THEN"));
assert(migration.includes('provider_reference_id=NEW.provider_transaction_id'));
assert(migration.includes("IF NEW.provider='paypal' THEN"));

const stripeBranch = migration
  .split("IF NEW.provider='stripe' THEN")[1]
  .split("IF NEW.provider='paypal' THEN")[0];

assert(
  !/INSERT\s+INTO\s+payment_history_transactions/i.test(stripeBranch),
  'Stripe legacy terms must never manufacture provider accounting rows'
);

assert(!/INSERT\s+INTO\s+payment_history_import_runs/i.test(migration));
assert(!/\bUPDATE\s+subscriptions\b/i.test(migration));
assert(!/\bINSERT\s+INTO\s+subscriptions\b/i.test(migration));

console.log('legacy payment history bridge smoke: ok');
