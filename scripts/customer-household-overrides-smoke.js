'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const migration = read('db/migrations/106_customer_override_gaps.sql');
const policy = read('src/jellyfin/policy.js');
const viewV2 = read('src/platform/customer-360-view-v2.js');
const lanePolicy = read('src/platform/admin-lane-policy.js');
const provisioningEngine = read('src/jellyfin/provisioning-engine.js');
const laneOverrides = read('src/jellyfin/lane-policy-overrides.js');
const householdOverridesSource = read('src/entitlements/household-overrides.js');
const jellyfinHouseholdPolicy = read('src/jellyfin/household-network-policy.js');
const stremioHouseholdAccess = read('src/stremio/household-access.js');
const admin360 = read('src/platform/admin-customer-360.js');
const bulkOperations = read('src/platform/bulk-operations.js');
const customer360View = read('src/platform/customer-360-view.js');

// allow_subtitle_editing: the one TECHNICAL_FIELDS entry with no storage
// column anywhere before migration 106.
assert(policy.includes("'allow_subtitle_editing'"), 'policy.js TECHNICAL_FIELDS must include allow_subtitle_editing');
assert(migration.includes('customer_policy_overrides') && migration.includes('customer_lane_policy_overrides') && (migration.match(/ADD COLUMN IF NOT EXISTS allow_subtitle_editing boolean/g) || []).length === 2, 'migration 106 must add allow_subtitle_editing to both override tables');
assert(viewV2.includes("allow_subtitle_editing:'Subtitle editing'"), 'customer-360-view-v2.js FIELD_LABELS must label allow_subtitle_editing');
assert(lanePolicy.includes("allow_subtitle_editing: 'Subtitle editing'"), 'admin-lane-policy.js LABELS must label allow_subtitle_editing');
assert(provisioningEngine.includes('customer_id,${field}'), 'setPolicyOverrideField must write generically by field name so new TECHNICAL_FIELDS entries need no code change');
assert(laneOverrides.includes('policy.TECHNICAL_FIELDS'), 'lane-scoped override writer must stay generic over TECHNICAL_FIELDS');

// customer_household_overrides: genuinely missing before migration 106 -
// household network limit was plan-level only, no per-customer dial.
assert(migration.includes('CREATE TABLE IF NOT EXISTS customer_household_overrides'), 'migration 106 must create customer_household_overrides');
assert(migration.includes("CHECK (service IN ('jellyfin', 'stremio'))"), 'household override service column must be constrained to jellyfin/stremio');
assert(migration.includes('network_limit BETWEEN 1 AND 10'), 'household override network_limit must be range-constrained');

assert(householdOverridesSource.includes('async function get(customerId, service)') && householdOverridesSource.includes('async function set(customerId, service, networkLimit') && householdOverridesSource.includes('async function reset(customerId, service)'), 'household-overrides.js must expose get/set/reset');
assert(/n < 1 \|\| n > 10/.test(householdOverridesSource), 'household-overrides.js set() must validate the 1-10 range, matching the DB constraint');

// Runtime enforcement must read the override ahead of the plan default /
// commercial snapshot, not just the admin UI.
assert(jellyfinHouseholdPolicy.includes("require('../entitlements/household-overrides')") && jellyfinHouseholdPolicy.includes("householdOverrides.get(customerId, 'jellyfin')") && jellyfinHouseholdPolicy.includes('entitlement.jellyfin_household_network_limit = override.network_limit'), 'Jellyfin household network policy must apply the per-customer override before computing the plan component');
assert(stremioHouseholdAccess.includes("require('../entitlements/household-overrides')") && stremioHouseholdAccess.includes("householdOverrides.get(entitlement.customer_id, 'stremio')") && stremioHouseholdAccess.includes('plan.stremio_household_network_limit = override.network_limit'), 'Stremio household access must apply the per-customer override ahead of the snapshot/plan default');

// Admin UI: save + reset-all routes, and reset_overrides (the bulk
// "Reset all to plan" action) must cover household overrides too so it
// stays a genuine reset-everything action.
assert(admin360.includes("/admin/users/:customerId/household-overrides'") && admin360.includes("/admin/users/:customerId/household-overrides/reset-all'"), 'Customer 360 must expose save and reset-all routes for household overrides');
assert(customer360View.includes('/household-overrides') && customer360View.includes('Stremio household network'), 'Stremio-only customers must also get a household override control, not just Jellyfin/bundle customers');
assert(bulkOperations.includes("require('../entitlements/household-overrides')") && bulkOperations.includes('householdOverrides.SERVICES.map(service=>householdOverrides.reset(item.customer_id,service))'), "the reset_overrides bulk action ('Reset all to plan') must also clear household overrides");

console.log('customer household overrides smoke: ok');
