'use strict';

const assert = require('assert');
const fs = require('fs');
const planExpiry = require('../src/entitlements/plan-expiry');

const read = path => fs.readFileSync(path, 'utf8');
const now = new Date('2026-08-23T10:00:00.000Z');

const free = { is_free_tier: true, billing_interval: 'custom', duration_days: 30 };
const trial = { is_free_tier: false, billing_interval: 'trial', duration_days: null };
const paid = { is_free_tier: false, billing_interval: 'month', duration_days: null };

assert.strictEqual(planExpiry.endForPlan(free, { now }).toISOString(), planExpiry.FREE_TIER_END_ISO, 'Free Access must use the non-expiring sentinel');
assert.strictEqual(planExpiry.endForPlan(free, { override: '2026-09-01', now }).toISOString(), planExpiry.FREE_TIER_END_ISO, 'An expiry override must not make Free Access time-limited');
assert.strictEqual(planExpiry.endForPlan(trial, { now }).toISOString(), '2026-08-24T10:00:00.000Z', 'A trial without an explicit duration must keep the one-day fallback');
assert.strictEqual(planExpiry.endForPlan(paid, { now }).toISOString(), '2026-09-22T10:00:00.000Z', 'A paid plan without an explicit duration must keep the 30-day fallback');
assert.strictEqual(planExpiry.endForPlan(paid, { override: '2026-09-30', now }).toISOString(), '2026-09-30T23:59:59.999Z', 'Date-only expiry overrides must run through the end of the selected day');
assert.strictEqual(planExpiry.visibleExpiry(free, '2026-09-21T00:00:00Z'), null, 'Free Access must not expose an expiry value');

const lifecycle = read('src/payments/lifecycle.js');
assert(/const endsAt=permanentEnd\(\)/.test(lifecycle), 'Self-service Free Access claims must always be non-expiring');
assert(/!planExpiry\.isFreeTier\(plan\)/.test(lifecycle), 'Free claims must require the canonical free-tier flag');

const importer = read('src/jellyfin/user-import.js');
assert(/planExpiry\.endForPlan\(plan, \{ override \}\)/.test(importer), 'Jellyfin imports must use the shared plan-expiry policy');

const adminActions = read('src/platform/admin-actions.js');
assert(/planExpiry\.endForPlan\(plan,\{now\}\)/.test(adminActions), 'Admin-created customers must use the shared plan-expiry policy');

const manual = read('src/entitlements/manual-subscriptions.js');
assert(/planExpiry\.isFreeTier\(plan\)/.test(manual) && /planExpiry\.freeTierEnd\(\)/.test(manual), 'Manual grants must normalize Free Access to non-expiring');

const bulk = read('src/platform/bulk-operations.js');
assert(/Free Access has no expiry to extend/.test(bulk), 'Bulk extension must reject Free Access');
assert(/Free Access does not use an expiry date/.test(bulk), 'Bulk expiry editing must reject Free Access');
assert(/current_period_end=\$12/.test(bulk), 'Local plan changes must refresh the expiry contract for the target plan');

const filters = read('src/platform/customer-filters.js');
assert(/CASE WHEN COALESCE\(p\.is_free_tier,FALSE\) THEN NULL ELSE cur\.current_period_end END AS current_period_end/.test(filters), 'Customers list/export must suppress the internal free-tier sentinel');
assert(/COALESCE\(p\.is_free_tier,FALSE\)=FALSE AND cur\.current_period_end/.test(filters), 'Expiry filters must exclude Free Access');

const customer360 = read('src/platform/customer-360.js');
assert(/CASE WHEN p\.is_free_tier THEN NULL ELSE s\.current_period_end END AS current_period_end/.test(customer360), 'Customer 360 must suppress the internal free-tier sentinel');

const dashboard = read('src/platform/customer-dashboard.js');
assert(/Boolean\(currentPlan\?\.is_free_tier\)/.test(dashboard), 'Customer portal must present Free Access as permanent/non-expiring');

const migration = read('db/migrations/031_free_tier_non_expiring.sql');
assert(/p\.is_free_tier = TRUE/.test(migration), 'Migration must target only canonical free-tier subscriptions');
assert(/s\.superseded_by IS NULL/.test(migration), 'Migration must not revive superseded free subscriptions');
assert(/s\.status IN \('active','trialing','past_due','paused'\)/.test(migration), 'Migration must repair only live-status Free Access subscriptions');
assert(/service_extension_days = 0/.test(migration), 'Migration must clear meaningless service extensions on Free Access');
assert(/9999-12-31 23:59:59/.test(migration), 'Migration must apply the engine-compatible non-expiring sentinel');

console.log('Free Access non-expiry regression checks passed.');
