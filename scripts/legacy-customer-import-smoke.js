'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const legacy = require('../src/payments/legacy-customer-import');

const files = [
  { name: 'Users.csv', text: 'ID,Name,Email,Expiration\n42,"Customer, Legacy",legacy@example.com,2027-05-08 00:00:00\n' },
  { name: 'Payments.csv', text: 'ID,Email,Plan,Date,Transaction ID,Processor,Type,Amount,From,To\n10,legacy@example.com,Yearly - 6 streams,2026-04-18 12:00:00,pi_legacy_1,Stripe,Payment,$40.00,2026-04-18 12:00:00,2027-05-08 12:00:00\n11,future@example.com,3 Streams - 6 Months,2026-08-01 00:00:00,TXN-FUTURE,PayPal,Payment,$20.00,2027-05-08 12:00:00,2027-11-08 12:00:00\n12,trial@example.com,24h Trial,2026-08-01 00:00:00,TXN-TRIAL,PayPal,Payment,$0.00,2026-08-01 00:00:00,2026-08-02 00:00:00\n' }
];

const parsed = legacy.parseCsv(files[0].text);
assert.strictEqual(parsed[0].name, 'Customer, Legacy', 'quoted commas must survive CSV parsing');
assert.strictEqual(parsed[0].email, 'legacy@example.com');

const input = legacy.normalizedInputs(files);
assert.strictEqual(input.users.size, 1);
assert.strictEqual(input.payments.length, 3);
assert.strictEqual(input.payments[0].user.legacyUserId, '42', 'Users export identity should enrich a matching payment email');
assert.strictEqual(input.payments[0].provider, 'stripe');
assert.strictEqual(input.payments[0].money.minor, 4000);
assert.strictEqual(input.payments[0].money.currency, 'USD');

for (const [name, interval, streams] of [
  ['Monthly - 3 Streams', 'month', 3],
  ['3 Streams - Monthly', 'month', 3],
  ['6 Months - 3 streams', '6_months', 3],
  ['3 Streams - 6 Months', '6_months', 3],
  ['Yearly - 3 Streams', 'year', 3],
  ['3 Streams - Yearly', 'year', 3],
  ['Yearly - 6 streams', 'year', 6]
]) {
  const plan = legacy.parseLegacyPlan(name);
  assert.strictEqual(plan.interval, interval, `${name} must map to ${interval}`);
  assert.strictEqual(plan.streams, streams, `${name} must preserve its stream count`);
}
assert.strictEqual(legacy.parseLegacyPlan('24h Trial').trial, true);

const currentPlans = [
  { id: 'monthly', name: 'Monthly', code: 'monthly', billing_interval: 'month', duration_days: 30, streams: 3, service_type: 'jellyfin', server_class: 'premium' },
  { id: 'six', name: '6 Months', code: 'six-month', billing_interval: '6_months', duration_days: 180, streams: 3, service_type: 'jellyfin', server_class: 'premium' },
  { id: 'year', name: 'Yearly', code: 'yearly', billing_interval: 'year', duration_days: 365, streams: 3, service_type: 'jellyfin', server_class: 'premium' }
];
const sixStream = legacy.choosePlan(legacy.parseLegacyPlan('Yearly - 6 streams'), currentPlans);
assert.strictEqual(sixStream.plan.id, 'year', 'a single yearly plan may carry a grandfathered stream override');
assert.strictEqual(sixStream.streamOverride, true, 'legacy 6-stream allowance must be explicitly preserved');
const exactSixMonth = legacy.choosePlan(legacy.parseLegacyPlan('3 Streams - 6 Months'), currentPlans);
assert.strictEqual(exactSixMonth.plan.id, 'six');
assert.strictEqual(exactSixMonth.streamOverride, false);

const now = new Date('2026-08-26T06:18:00Z');
const currentCandidate = legacy.basicCandidate(input.payments[0], now);
assert.strictEqual(currentCandidate.state, 'ready_current');
const futureCandidate = legacy.basicCandidate(input.payments[1], now);
assert.strictEqual(futureCandidate.state, 'ready_future', 'prepaid future terms must be retained rather than discarded');
assert.strictEqual(legacy.basicCandidate(input.payments[2], now).state, 'excluded', 'zero-dollar trial rows must never create paid access');


const overlapCandidate = { start: new Date('2026-07-22T00:00:00Z'), end: new Date('2027-07-22T00:00:00Z') };
const localPartial = { id: 'local-year', plan_id: 'year', source: 'migration', status: 'active', provider_subscription_id: null, effective_price_minor: 6000, starts_at: new Date('2026-07-22T00:00:00Z'), current_period_end: new Date('2027-01-22T00:00:00Z') };
assert.strictEqual(legacy.existingPaidDecision(overlapCandidate, 'year', [localPartial]).kind, 'extend', 'same-plan local paid access may be safely extended to the trusted legacy expiry');
assert.strictEqual(legacy.existingPaidDecision(overlapCandidate, 'six', [localPartial]).kind, 'review', 'a different-plan overlap must remain manual review');
const liveRecurring = { ...localPartial, id: 'stripe-live', source: 'stripe', billing_mode: 'subscription', provider_subscription_id: 'sub_live_123', status: 'active' };
assert.strictEqual(legacy.existingPaidDecision(overlapCandidate, 'year', [liveRecurring]).kind, 'covered_recurring', 'verified recurring provider access must never be overwritten by CSV migration');
const duplicateLocal = { ...localPartial, id: 'local-year-2' };
assert.strictEqual(legacy.existingPaidDecision(overlapCandidate, 'year', [localPartial, duplicateLocal]).kind, 'review', 'multiple local paid overlaps must never be guessed');

const snapshot = legacy.commercialSnapshot({ ...input.payments[0], plan: legacy.parseLegacyPlan('Yearly - 6 streams') }, currentPlans[2]);
assert.strictEqual(snapshot.kind, 'legacy_import');
assert.strictEqual(snapshot.streams, 6, 'legacy stream count must override the current public plan in the immutable contract snapshot');
assert.strictEqual(snapshot.priceMinor, 4000, 'legacy paid price must be preserved instead of substituting today\'s catalogue price');
assert.strictEqual(snapshot.legacyTransactionId, 'pi_legacy_1');

const root = path.join(__dirname, '..');
const serviceSource = fs.readFileSync(path.join(root, 'src/payments/legacy-customer-import.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'src/platform/admin-legacy-customer-import.js'), 'utf8');
const uploadSource = fs.readFileSync(path.join(root, 'public/js/admin-legacy-customer-import.js'), 'utf8');
const migrationSource = fs.readFileSync(path.join(root, 'db/migrations/043_legacy_paid_user_import.sql'), 'utf8');
const mappingSource = fs.readFileSync(path.join(root, 'src/platform/admin-provider-mappings.js'), 'utf8');

assert(serviceSource.includes("'active','migration'"), 'legacy access must be stored with the dedicated migration source');
assert(!serviceSource.includes('activatePurchase('), 'legacy CSV rows must never enter the provider payment activation handler');
assert(!/provider_subscription_id\s*=/.test(serviceSource), 'payment transaction IDs must never be faked into recurring provider subscription IDs');
assert(serviceSource.includes('cancel_at_period_end') && serviceSource.includes('TRUE'), 'restored terms must end on their exported To date until verified live recurring state is linked');
assert(serviceSource.includes('legacy_subscription_imports') && serviceSource.includes('provider_transaction_id'), 'migration must be idempotent on original provider transaction identity');
assert(serviceSource.includes('existingPaidDecision') && serviceSource.includes('GREATEST(current_period_end'), 'same-plan local paid overlaps must use the guarded extension path instead of forcing manual review');
assert(serviceSource.includes("plan_id=$5 AND superseded_by IS NULL AND status='active'"), 'extension writes must re-check same plan, live status and unsuperseded ownership under lock');
assert(serviceSource.includes('customersByJellyfinName') && serviceSource.includes('jellyfin_username'), 'legacy Users names must be able to match an already-managed Jellyfin customer');
assert(serviceSource.includes("COALESCE(ja.account_purpose,'jellyfin')='jellyfin'"), 'identity matching must only use customer-facing Jellyfin identities');
assert(serviceSource.includes('needsJellyfinLink') && serviceSource.includes('managedAccount'), 'unlinked CSV-only customers must not be blindly provisioned into duplicate Jellyfin accounts');
assert(!serviceSource.includes('if (candidate.start <= now) customerIds.add(String(customer.row.id));'), 'current imports must only reconcile after confirming a managed Jellyfin account');
assert(migrationSource.includes('UNIQUE(source_system, provider, provider_transaction_id)'), 'database must enforce legacy import idempotency');
assert(migrationSource.includes('never represents a new provider charge'), 'migration ledger must document the no-charge boundary');
assert(adminSource.includes('csrf.verify(req)'), 'preview/apply must be CSRF protected');
assert(adminSource.includes("req.body?.confirm !== '1'"), 'apply must require explicit operator confirmation');
assert(adminSource.includes('It does not charge customers'), 'admin UI must state that migration does not create a provider charge');
assert(adminSource.includes('Matched existing managed Jellyfin user') && adminSource.includes('deliberately did not create a duplicate Jellyfin user'), 'admin preview/result must explain managed-identity matching and safe unlinked handling');
assert(adminSource.includes('Extend existing access'), 'safe same-plan legacy extensions must be clearly labelled in the preview UI');
assert(uploadSource.includes('multiple') || adminSource.includes('multiple'), 'operator must be able to select all Users/Payments CSVs together');
assert(uploadSource.includes('650 * 1024'), 'browser upload must remain safely below the application request-body ceiling');
assert(mappingSource.includes('Use Migrate paid users'), 'Provider mappings must redirect confused migration operators to the correct workflow');


// Export must be a real round trip into the existing migration parser.
const portableExport = require('../src/payments/data-export');
const exportedUsers = portableExport.usersCsv([{
  customer_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', export_name:'Portable User', email:'portable@example.com',
  expiration:new Date('2027-08-26T00:00:00Z'), portal_username:'portable', display_name:'Portable User',
  jellyfin_usernames:'portable-jf', created_at:new Date('2026-01-01T00:00:00Z')
}]);
const exportedPayments = portableExport.paymentsCsv([{
  subscription_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email:'portable@example.com', plan_name:'Yearly', plan_code:'yearly', plan_streams:6,
  status:'active', source:'stripe', provider_subscription_id:'sub_real_exported_metadata', provider_customer_id:'cus_real', provider_price_id:'price_real',
  starts_at:new Date('2026-08-26T00:00:00Z'), current_period_end:new Date('2027-08-26T00:00:00Z'), commercial_snapshot:{streams:6},
  amount_minor:6000, currency:'USD', legacy_provider:null, legacy_transaction_id:null, legacy_payment_id:null
}]);
const roundTrip = legacy.normalizedInputs([{name:'Users.csv',text:exportedUsers},{name:'Payments.csv',text:exportedPayments}]);
assert.strictEqual(roundTrip.users.size,1,'exported Users.csv must be accepted by the migration parser');
assert.strictEqual(roundTrip.payments.length,1,'exported Payments.csv must be accepted by the migration parser');
assert.strictEqual(roundTrip.payments[0].email,'portable@example.com');
assert.strictEqual(roundTrip.payments[0].plan.interval,'year');
assert.strictEqual(roundTrip.payments[0].plan.streams,6,'portable export must preserve grandfathered stream allowance');
assert.strictEqual(roundTrip.payments[0].money.minor,6000);
assert.strictEqual(roundTrip.payments[0].provider,'manual','synthetic CAPTAiNFiN migration references must never masquerade as Stripe/PayPal transactions');
assert.strictEqual(roundTrip.payments[0].transactionId,'captainfin-sub-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
const zip = portableExport.zipStore([{name:'Users.csv',data:exportedUsers},{name:'Payments.csv',data:exportedPayments}],new Date('2026-08-26T00:00:00Z'));
assert.strictEqual(zip.readUInt32LE(0),0x04034b50,'migration bundle must be a valid ZIP local-header stream');
assert(zip.includes(Buffer.from('Users.csv'))&&zip.includes(Buffer.from('Payments.csv')),'migration bundle must contain the round-trip CSV files');
const exportServiceSource=fs.readFileSync(path.join(root,'src/payments/data-export.js'),'utf8');
const exportAdminSource=fs.readFileSync(path.join(root,'src/platform/admin-data-export.js'),'utf8');
for(const forbidden of ['password_hash','api_key_encrypted','client_secret_encrypted','access_token_encrypted','totp_secret'])assert(!exportServiceSource.includes(forbidden),`portable export query must never select ${forbidden}`);
assert(exportAdminSource.includes("csrf.verify(req)"),'every export download must be CSRF protected');
assert(exportAdminSource.includes("'admin.data_export.download'")||exportServiceSource.includes("'admin.data_export.download'"),'sensitive export downloads must be audit logged');
assert(exportAdminSource.includes('Passwords, sessions, API keys')||exportAdminSource.includes('passwords, password hashes'),'export UI must explicitly disclose excluded secrets');
assert(exportAdminSource.includes('@media(max-width:760px)'),'Export data cards/actions must have a phone layout');

console.log('legacy customer import smoke: ok');
