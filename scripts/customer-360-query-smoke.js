'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const serviceTruth = require('../src/platform/customer-360-service-truth');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'platform', 'customer-360.js'), 'utf8');
const viewSource = fs.readFileSync(path.join(root, 'src', 'platform', 'customer-360-view.js'), 'utf8');
const truthSource = fs.readFileSync(path.join(root, 'src', 'platform', 'customer-360-service-truth.js'), 'utf8');
const compactSource = fs.readFileSync(path.join(root, 'src', 'platform', 'customer-360-compact.js'), 'utf8');

assert(source.includes("entity_type='customer' AND entity_id::text=$1::text"), 'Customer 360 audit lookup must compare audit entity UUIDs through a consistent text cast');
assert(source.includes("entity_type='subscription' AND entity_id::text IN (SELECT id::text FROM subscriptions WHERE customer_id=$1::uuid)"), 'Customer 360 subscription audit lookup must cast the route parameter explicitly before comparing it with subscriptions.customer_id');
assert(!source.includes("entity_id=$1::text"), '360 audit queries must not compare a UUID column directly to text');

// The compact operator page has three deliberately separate concepts:
// playback activity, financial/provider history, and operational logs.
assert(compactSource.includes("const rows=(detail.playback||[]).slice(0,75)"), 'Customer 360 Activity must be driven by playback history rather than the generic audit timeline');
assert(!compactSource.includes("function activityDisclosure(detail){const rows=(detail.timeline||[])"), 'generic customer/audit events must not be presented as playback Activity');
assert(compactSource.includes('No playback activity recorded yet.'), 'Activity must use clear playback-specific empty copy');
assert(compactSource.includes('provider_transaction_id,provider_reference_id,provider_source_id,provider_customer_id'), 'Payments must load provider identifiers needed for provider-side reconciliation');
assert(compactSource.includes("s.source='plisio'"), 'Customer 360 Payments must include Plisio purchases as well as imported Stripe/PayPal history');
assert(compactSource.includes('payment_incidents'), 'Payments must surface disputes, refunds, chargebacks and other payment incidents');
assert(compactSource.includes("['Transaction',row.provider_transaction_id]"), 'Payments must label the provider transaction identifier');
assert(compactSource.includes("['Reference',row.provider_reference_id]"), 'Payments must expose provider reference identifiers rather than collapsing to one ID');
assert(compactSource.includes('Refunds, disputes & payment incidents'), 'Payments must explicitly distinguish provider incidents from ordinary transaction rows');
assert(compactSource.includes("function logsDisclosure(detail){const runs=(detail.runs||[]).slice(0,50)"), 'Logs must remain the operational provisioning/reconciliation history');

assert(viewSource.includes("serviceTruth=require('./customer-360-service-truth')"), 'Customer 360 must derive per-service rows through one dedicated truth helper');
assert(viewSource.includes('Service reconciliation truth'), 'Overview must expose per-service desired/observed reconciliation state');
assert(viewSource.includes('No reconciliation snapshot'), 'missing observed state must be shown as unknown rather than silently healthy');
assert(truthSource.includes('state.last_result || state.detail?.result || {}'), 'service truth must consume the canonical persisted reconciliation result');
assert(truthSource.includes("type === service || type === 'bundle'"), 'per-service truth must explicitly scope direct and bundle entitlements');
assert(!truthSource.includes("require('../db')") && !truthSource.includes('SELECT '), 'service truth must not create a second business-logic query path');

const reconciledAt = '2026-09-03T09:30:00.000Z';
const rows = serviceTruth.resultRows({
  subscriptions: [
    { id: 'sub-paid', status: 'active', current_period_end: '2026-10-03T00:00:00.000Z', service_type: 'jellyfin', plan_code: 'premium' },
    { id: 'sub-stremio', status: 'active', current_period_end: '2026-10-03T00:00:00.000Z', service_type: 'stremio', plan_code: 'stremio-plus' }
  ],
  primaryEntitlement: { subscription_id: 'sub-paid', status: 'active', service_type: 'jellyfin', contract_plan_code: 'premium' },
  accounts: [{ id: 'acc-1', access_lane: 'primary', disabled: false, jellyfin_username: 'customer', server_name: 'Premium Server' }],
  provisioningState: {
    status: 'healthy',
    last_result: {
      primary: { active: true, blocked: false, subscriptionId: 'sub-paid', planCode: 'premium', accountId: 'acc-1', serverId: 'srv-1' },
      free: null,
      emby: null,
      stremioStatus: 'active',
      discordStatus: 'synced',
      blockers: [],
      reconciledAt
    }
  }
});
assert.deepStrictEqual(rows.map(row => row.service), ['Jellyfin primary','Jellyfin Free','Emby','Stremio','Discord roles']);
assert.strictEqual(rows[0].desired, 'Enabled');
assert.strictEqual(rows[0].actual, 'Active');
assert.strictEqual(rows[0].plan, 'premium');
assert.strictEqual(rows[0].target, 'acc-1 · srv-1');
assert.strictEqual(rows[3].actual, 'active');
assert.strictEqual(rows[4].actual, 'synced');
assert.strictEqual(rows[0].reconciledAt, reconciledAt);

const unknownRows = serviceTruth.resultRows({ subscriptions: [], accounts: [], provisioningState: null });
assert.strictEqual(unknownRows[0].actual, 'No reconciliation snapshot');
assert.strictEqual(unknownRows[3].actual, 'No reconciliation snapshot');
assert.strictEqual(unknownRows[0].desired, 'Not required');

const blockedRows = serviceTruth.resultRows({
  subscriptions: [{ status: 'active', current_period_end: '2026-10-03T00:00:00.000Z', service_type: 'jellyfin', plan_code: 'premium' }],
  primaryEntitlement: { status: 'active', service_type: 'jellyfin', contract_plan_code: 'premium' },
  activeHolds: [{ hold_type: 'admin_suspended' }],
  provisioningState: { status: 'blocked', last_error: 'Support suspension under review', last_result: { primary: { active: false, blocked: true, planCode: 'premium' }, blockers: ['admin_suspended'] } }
});
assert.strictEqual(blockedRows[0].desired, 'Blocked by access hold');
assert.strictEqual(blockedRows[0].actual, 'Blocked');
assert.match(blockedRows[0].issue, /admin_suspended/);

const stremioOnlyRows = serviceTruth.resultRows({
  subscriptions: [{ status: 'active', current_period_end: '2026-10-03T00:00:00.000Z', service_type: 'stremio', plan_code: 'stremio-only' }],
  primaryEntitlement: { status: 'active', service_type: 'stremio', contract_plan_code: 'stremio-only' },
  accounts: [],
  provisioningState: { status: 'healthy', last_result: { stremioStatus: 'active', discordStatus: 'synced', reconciledAt } }
});
assert.strictEqual(stremioOnlyRows[0].desired, 'Not required', 'Stremio primary entitlement must never be projected into the Jellyfin primary lane');
assert.strictEqual(stremioOnlyRows[0].plan, '—');
assert.strictEqual(stremioOnlyRows[3].desired, 'Enabled');
assert.strictEqual(stremioOnlyRows[3].plan, 'stremio-only');

console.log('customer 360 UUID audit + per-service truth + activity/payment semantics smoke: ok');
