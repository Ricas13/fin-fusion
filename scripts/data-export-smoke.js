'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const dataExport = require('../src/payments/data-export');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const users = dataExport.usersCsv([{
  customer_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  export_name: 'CSV User',
  email: 'csv@example.com',
  expiration: new Date('2027-08-26T00:00:00Z'),
  portal_username: 'csv-user',
  display_name: 'CSV User',
  jellyfin_usernames: 'csv-jf',
  created_at: new Date('2026-01-01T00:00:00Z')
}]);
assert(users.startsWith('\uFEFFID,Name,Email,Expiration'), 'Users export must remain an Excel-friendly CSV');
assert(users.includes('csv@example.com') && users.includes('csv-jf'), 'Users export must retain customer and Jellyfin identity fields');

const payments = dataExport.paymentsCsv([{
  subscription_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  email: 'csv@example.com',
  plan_name: 'Yearly',
  plan_code: 'yearly',
  plan_streams: 6,
  status: 'active',
  source: 'stripe',
  provider_subscription_id: 'sub_real',
  provider_customer_id: 'cus_real',
  provider_price_id: 'price_real',
  starts_at: new Date('2026-08-26T00:00:00Z'),
  current_period_end: new Date('2027-08-26T00:00:00Z'),
  commercial_snapshot: { streams: 6 },
  amount_minor: 6000,
  currency: 'USD',
  legacy_provider: null,
  legacy_transaction_id: null,
  legacy_payment_id: null
}]);
assert(payments.includes('Provider Subscription ID') && payments.includes('sub_real'), 'Payments CSV must preserve provider subscription metadata');
assert(payments.includes('Yearly - 6 Streams'), 'Payments CSV must preserve the effective stream allowance');

const transactions = dataExport.transactionsCsv([{
  provider: 'stripe',
  provider_transaction_id: 'txn_real',
  transaction_type: 'charge',
  transaction_status: 'available',
  occurred_at: new Date('2026-08-26T12:00:00Z'),
  currency: 'GBP',
  gross_amount_minor: 1000,
  fee_amount_minor: 59,
  net_amount_minor: 941,
  provider_customer_id: 'cus_real',
  provider_reference_id: 'pi_real',
  provider_source_id: 'ch_real',
  customer_email: 'csv@example.com',
  portal_username: 'csv-user'
}]);
assert(transactions.includes('Classification') && transactions.includes('payment'), 'Transactions CSV must retain canonical payment classification');
assert(transactions.includes('txn_real'), 'Transactions CSV must retain original provider transaction IDs');

const exportServiceSource = read('src/payments/data-export.js');
const exportAdminSource = read('src/platform/admin-data-export.js');
for (const forbidden of ['password_hash','api_key_encrypted','client_secret_encrypted','access_token_encrypted','totp_secret']) {
  assert(!exportServiceSource.includes(forbidden), `CSV export query must never select ${forbidden}`);
}
assert(exportAdminSource.includes("csrf.verify(req)"), 'every CSV export download must be CSRF protected');
assert(exportAdminSource.includes("'admin.data_export.download'") || exportServiceSource.includes("'admin.data_export.download'"), 'sensitive CSV downloads must be audit logged');
for (const endpoint of ['/admin/payments/export/users','/admin/payments/export/payments','/admin/payments/export/transactions']) {
  assert(exportAdminSource.includes(endpoint), `${endpoint} must remain available`);
}
assert(!exportAdminSource.includes('/admin/payments/legacy-import'), 'Export data must not point back to the retired migration workflow');
assert(!exportAdminSource.includes('/admin/payments/export/bundle'), 'Only CSV export actions should remain exposed');
assert(!/Migration bundle|migration bundle|Round-trip rule|Migrate paid users/.test(exportAdminSource), 'Export UI must not retain migration-only copy');
assert(exportAdminSource.includes('@media(max-width:760px)'), 'Export data cards/actions must keep their phone layout');

console.log('data export smoke: ok');
