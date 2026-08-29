'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const db = require('../src/db');
const build = require('../src/build-info');
const refundPolicy = require('../src/payments/prorata-refunds');
const routeManifest = require('../src/platform/admin-route-manifest');

assert.strictEqual(build.version, '2.0.0', 'v2 must have one canonical 2.0.0 package/build identity');
assert.deepStrictEqual(build.providerAppInfo(), { name:'CAPTAiNFiN', version:'2.0.0' });

assert(db.isMutationSql('CALL rotate_something()'), 'CALL must acquire the mutation/restore lock');
assert(db.isMutationSql('DO $$ BEGIN NULL; END $$'), 'DO blocks must acquire the mutation/restore lock');
assert(db.isMutationSql('WITH x AS (SELECT 1) UPDATE example SET value=1'), 'mutating CTEs must acquire the mutation/restore lock');
assert(!db.isMutationSql('SELECT 1'), 'ordinary reads must remain reads');
assert.rejects(() => db.readQuery('CALL unsafe()'), /readQuery cannot execute SQL classified as a mutation/);

const started = new Date('2026-01-01T00:00:00Z');
const ended = new Date('2027-01-01T00:00:00Z');
const halfway = new Date(started.getTime() + ((ended.getTime() - started.getTime()) / 2));
const baseRow = {
  id:'00000000-0000-4000-8000-000000000001',
  customer_id:'00000000-0000-4000-8000-000000000002',
  source:'stripe',provider_subscription_id:'pi_test',status:'active',
  starts_at:started,current_period_end:ended,currency_snapshot:'GBP',
  plan_name_snapshot:'Annual',service_type_snapshot:'jellyfin',
  commercial_snapshot:{discountedMinor:4000,serviceCreditMinor:1000,currency:'GBP'}
};
const quote = refundPolicy.refundableQuoteFromRow(baseRow, { refundedMinor:0, now:halfway });
assert.strictEqual(quote.providerPaidMinor, 4000, 'cash basis must exclude service credit');
assert.strictEqual(quote.serviceCreditMinor, 1000);
assert.strictEqual(quote.refundMinor, 2000, 'half-unused annual service should refund half the provider cash');
const afterPrior = refundPolicy.refundableQuoteFromRow(baseRow, { refundedMinor:500, now:halfway });
assert.strictEqual(afterPrior.refundMinor, 1500, 'prior refunds must reduce the remaining pro-rata allowance');
const future = refundPolicy.refundableQuoteFromRow({ ...baseRow, starts_at:new Date('2027-01-01T00:00:00Z'), current_period_end:new Date('2028-01-01T00:00:00Z') }, { now:new Date('2026-12-01T00:00:00Z') });
assert.strictEqual(future.mode, 'future_full');
assert.strictEqual(future.refundMinor, 4000, 'a fully unused future period may refund all provider-paid cash');
assert.throws(() => refundPolicy.refundableQuoteFromRow({ ...baseRow, provider_subscription_id:'sub_recurring' }, { now:halfway }), /Recurring provider subscriptions/);

const referrals = read('src/referrals.js');
assert(referrals.includes("rr.status='pending'"), 'only pending referral redemptions may qualify');
assert(referrals.includes('ORDER BY s.starts_at,s.created_at LIMIT 1'), 'affiliate reward must bind to the first qualifying paid subscription');
assert(referrals.includes("SET status='rewarded'"), 'the referral must become terminally rewarded after qualification');
assert(referrals.includes('`affiliate:${redemption.id}`'), 'earned reward identity must be unique per referral redemption');

const composition = read('src/platform/admin-route-composition.js');
const tokens = {
  usersDashboard:'createAdminUsersDashboardRouter()',settingsCommerce:'createAdminSettingsCommerceRouter()',
  originalSettings:'createAdminOriginalSettingsRouter()',planAccess:'createAdminPlanAccessRouter()',
  plans:'createAdminPlansRouter()',impersonation:'createAdminImpersonationRouter()',
  lanePolicy:'createAdminLanePolicyRouter()',customer360:'createAdminCustomer360Router()'
};
for (const token of Object.values(tokens)) assert(composition.includes(token), `admin composition is missing ${token}`);
const actualCriticalOrder = Object.entries(tokens)
  .sort((a,b) => composition.indexOf(a[1]) - composition.indexOf(b[1]))
  .map(([name]) => name);
assert(routeManifest.assertAdminRouteOrder(actualCriticalOrder));
assert(composition.includes('createAdminProrataRefundsRouter'), 'the staff pro-rata refund workflow must be mounted in canonical admin composition');
assert(composition.includes('assertAdminRouteOrder(criticalOrder)'), 'production startup must enforce critical route precedence');

const nav = read('src/platform/admin-nav.js');
assert(!/reseller/i.test(nav), 'retired reseller product traces must not remain in admin navigation');
const recovery = read('src/payments/provider-operation-recovery.js');
assert(/operation_type\s*===\s*['"]prorata_refund['"]/.test(recovery), 'provider recovery must own unresolved pro-rata refunds');

for (const file of ['src/payments/provider-operation-recovery.js','src/payments/billing-control.js','src/payments/prorata-refunds.js']) {
  const source = read(file);
  assert(!/appInfo:\s*\{\s*name:\s*['\"]CAPTAiNFiN['\"],\s*version:\s*['\"](?:1\.0\.0|1\.4\.0)['\"]/.test(source), `${file} must not hard-code an old runtime version`);
}

console.log('v2 consolidation contracts smoke: ok');
