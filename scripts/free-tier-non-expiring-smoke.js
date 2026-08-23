'use strict';

const assert=require('assert');
const fs=require('fs');
const planExpiry=require('../src/entitlements/plan-expiry');
const read=file=>fs.readFileSync(file,'utf8');
const now=new Date('2026-08-23T10:00:00.000Z');

const free={is_free_tier:true,billing_interval:'custom',duration_days:30};
const trial={is_free_tier:false,billing_interval:'trial',duration_days:null};
const paid={is_free_tier:false,billing_interval:'month',duration_days:null};
assert.strictEqual(planExpiry.endForPlan(free,{now}).toISOString(),planExpiry.FREE_TIER_END_ISO,'Free Access must use the non-expiring sentinel');
assert.strictEqual(planExpiry.endForPlan(free,{override:'2026-09-01',now}).toISOString(),planExpiry.FREE_TIER_END_ISO,'expiry overrides must not time-limit canonical Free Access');
assert.strictEqual(planExpiry.endForPlan(trial,{now}).toISOString(),'2026-08-24T10:00:00.000Z','trials must remain time-bounded');
assert.strictEqual(planExpiry.endForPlan(paid,{now}).toISOString(),'2026-09-22T10:00:00.000Z','paid plans must remain time-bounded');
assert.strictEqual(planExpiry.visibleExpiry(free,'2026-09-21T00:00:00Z'),null,'Free Access must not expose the internal sentinel');

const lifecycle=read('src/payments/lifecycle.js');
assert(lifecycle.includes("const planExpiry = require('../entitlements/plan-expiry')"),'lifecycle must use shared expiry policy');
assert(lifecycle.includes('const endsAt=permanentEnd()'),'self-service Free Access must always be non-expiring');
assert(lifecycle.includes('!planExpiry.isFreeTier(plan)'),'free claims must require the canonical free-tier flag');

const migration=read('db/migrations/034_free_tier_non_expiring.sql');
assert(migration.includes('enforce_free_tier_non_expiring_subscription'),'database must enforce the invariant for every write path');
assert(migration.includes('p.is_free_tier=TRUE'),'migration must target only canonical Free Access');
assert(migration.includes("s.status IN ('active','trialing','past_due','paused')"),'migration must only repair live Free Access rows');
assert(migration.includes('service_extension_days=0'),'Free Access must not carry meaningless extension days');
assert(migration.includes('9999-12-31 23:59:59'),'engine-compatible non-expiring sentinel must remain stable');

const filters=read('src/platform/customer-filters.js');
assert(filters.includes('CASE WHEN COALESCE(p.is_free_tier,FALSE) THEN NULL ELSE cur.current_period_end END AS current_period_end'),'customer list/export must hide the sentinel');
const customer360=read('src/platform/customer-360.js');
assert(customer360.includes('CASE WHEN p.is_free_tier THEN NULL ELSE s.current_period_end END AS current_period_end'),'Customer 360 must hide the sentinel');
const dashboard=read('src/platform/customer-dashboard.js');
assert(dashboard.includes('Boolean(currentPlan?.is_free_tier)'),'customer portal must present canonical Free Access as permanent');

const inactivityStatus=read('src/automation/customer-inactivity-status.js');
const inactivity=read('src/automation/customer-inactivity.js');
assert(inactivityStatus.includes("kind:'playback'")&&inactivityStatus.includes('lastPlaybackForCustomer'),'Free inactivity must continue to use Jellyfin playback, not billing expiry');
assert(inactivityStatus.includes('safetyHold:true')&&inactivity.includes('activity_data_unhealthy'),'unhealthy/stale playback telemetry must continue to fail safe instead of removing Free Access');

console.log('Free Access non-expiry + playback-inactivity separation checks passed.');
