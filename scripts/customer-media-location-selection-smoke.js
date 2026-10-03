'use strict';

const assert = require('assert');
const fs = require('fs');
const choice = require('../src/jellyfin/customer-server-choice');

const plan = {
  id: '11111111-1111-1111-1111-111111111111',
  server_class: 'premium',
  service_type: 'jellyfin',
  billing_interval: 'month',
  price_minor: 1000,
  placement_strategy: 'balanced'
};

const servers = [
  {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    name: 'London A',
    location: 'London',
    server_class: 'premium',
    media_server_type: 'jellyfin',
    enabled: true,
    allow_new_users: true,
    paid_enabled: true,
    trial_enabled: true,
    placement_mode: 'active',
    health_status: 'healthy',
    max_users: 10,
    priority: 10,
    public_url: 'https://london-a.example.invalid'
  },
  {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    name: 'London B',
    location: ' london ',
    server_class: 'premium',
    media_server_type: 'jellyfin',
    enabled: true,
    allow_new_users: true,
    paid_enabled: true,
    trial_enabled: true,
    placement_mode: 'active',
    health_status: 'healthy',
    max_users: 10,
    priority: 20,
    public_url: 'https://london-b.example.invalid'
  },
  {
    id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    name: 'Germany',
    location: 'Germany',
    server_class: 'premium',
    media_server_type: 'jellyfin',
    enabled: true,
    allow_new_users: true,
    paid_enabled: true,
    trial_enabled: true,
    placement_mode: 'active',
    health_status: 'healthy',
    max_users: 5,
    priority: 30,
    public_url: 'https://germany.example.invalid'
  }
];

function fakeDb({ fullGermany = false, disabledAssigned = false } = {}) {
  return async (sql, params = []) => {
    if (sql.includes("setting_key='operations_v1'")) {
      return { rowCount: 1, rows: [{ setting_value: { placementHealthMode: 'healthy_or_degraded' } }] };
    }
    if (sql.includes('WITH restriction AS')) {
      return { rowCount: servers.length, rows: servers.map(server => ({ ...server, placement_weight: 100 })) };
    }
    if (sql.includes('WITH capacity_users AS')) {
      return {
        rowCount: fullGermany ? 1 : 0,
        rows: fullGermany ? [{ server_id: servers[2].id, users: 5 }] : []
      };
    }
    if (sql.includes('WHERE id=ANY($1::uuid[])') && sql.includes('FOR UPDATE')) {
      return { rowCount: params[0]?.length || 0, rows: (params[0] || []).map(id => ({ id })) };
    }
    if (sql.includes('FROM jellyfin_servers') && sql.includes('WHERE id=$1')) {
      const server = servers.find(item => item.id === params[0]);
      return { rowCount: server ? 1 : 0, rows: server ? [{ ...server, enabled: disabledAssigned ? false : server.enabled }] : [] };
    }
    if (sql.includes('FROM active_playback_sessions')) return { rowCount: 0, rows: [] };
    throw new Error('Unexpected customer-location smoke SQL: ' + sql.slice(0, 140));
  };
}

(async () => {
  assert.strictEqual(choice.locationLabel('  London   '), 'London');
  assert.strictEqual(choice.locationLabel(''), 'Default');
  assert.strictEqual(choice.matchesPreference({ location: ' london ' }, 'London'), true);
  assert.strictEqual(choice.matchesPreference({ location: 'Germany' }, 'London'), false);
  assert.strictEqual(choice.mediaServerType({ service_type: 'bundle' }), 'jellyfin');
  assert.strictEqual(choice.mediaServerType({ service_type: 'emby' }), 'emby');
  assert.strictEqual(choice.mediaServerType({ service_type: 'stremio' }), null);

  const grouped = await choice.choicesForPlan(plan, { db: fakeDb() });
  assert.strictEqual(grouped.length, 2, 'two distinct locations must produce two customer choices');
  assert.strictEqual(grouped.find(item => item.value === 'London').serverCount, 2, 'same-location servers must be grouped behind one customer choice');
  assert.strictEqual(grouped.find(item => item.value === 'London').remaining, 20);
  assert.strictEqual(grouped.find(item => item.value === 'Germany').remaining, 5);
  await assert.rejects(() => choice.resolveAcquisitionLocation(plan, null, { db: fakeDb(), requireSelection: true }), /Choose a server location/);
  assert.strictEqual(await choice.resolveAcquisitionLocation(plan, 'gErMaNy', { db: fakeDb(), requireSelection: true }), 'Germany');

  const withFullGermany = await choice.choicesForPlan(plan, { db: fakeDb({ fullGermany: true }) });
  assert.deepStrictEqual(withFullGermany.map(item => item.value), ['London'], 'full locations must not be offered');
  assert.strictEqual(await choice.resolveAcquisitionLocation(plan, null, { db: fakeDb({ fullGermany: true }), requireSelection: true }), 'London', 'single remaining location must auto-select without a dropdown');

  const selected = await choice.selectServerForLocation(plan, 'London', { db: fakeDb() });
  assert(['London A', 'London B'].includes(selected.name), 'location selection must never escape the chosen location');
  const lockedSelected = await choice.selectServerForLocationLocked(plan, 'London', { db: fakeDb() });
  assert(['London A', 'London B'].includes(lockedSelected.name), 'serialized reservation must stay inside the chosen location');

  const sticky = await choice.assignedServer({ ...plan, media_server_id: servers[0].id }, 'jellyfin', { db: fakeDb() });
  assert.strictEqual(sticky.id, servers[0].id, 'persisted assignment must win over later pool ordering');
  const committed = await choice.committedReservedServer(plan, servers[0].id, 'London', { db: fakeDb() });
  assert.strictEqual(committed.id, servers[0].id, 'an operational server reserved before payment must remain the authoritative settlement target');
  const unusableCommitted = await choice.committedReservedServer(plan, servers[0].id, 'London', { db: fakeDb({ disabledAssigned: true }) });
  assert.strictEqual(unusableCommitted, null, 'a committed server disabled before settlement must fail over instead of producing paid access on an unusable target');

  let persistedParams = null;
  const assignmentDb = async (sql, params) => {
    if (!sql.includes('UPDATE subscriptions')) throw new Error('Unexpected assignment SQL');
    persistedParams = params;
    return { rowCount: 1, rows: [{ media_server_id: params[1], media_location_preference: params[2], media_location_snapshot: params[2] }] };
  };
  const accountShapedAssignment = {
    id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    server_id: servers[0].id,
    server_location: 'London'
  };
  await choice.persistAssignment(plan.id, accountShapedAssignment, { db: assignmentDb });
  assert.strictEqual(persistedParams[1], servers[0].id, 'persistAssignment must use account.server_id rather than mistaking the account id for a server foreign key');
  assert.strictEqual(persistedParams[2], 'London', 'persistAssignment must preserve the account server location snapshot');
  await assert.rejects(
    () => choice.assignedServer({ ...plan, media_server_id: servers[0].id }, 'jellyfin', { db: fakeDb({ disabledAssigned: true }) }),
    error => error && error.code === 'ASSIGNED_MEDIA_SERVER_UNAVAILABLE',
    'disabled sticky servers must fail closed instead of silently moving customers'
  );

  const checkout = fs.readFileSync('src/platform/flexible-checkout.js', 'utf8');
  const dashboard = fs.readFileSync('src/platform/customer-dashboard.js', 'utf8');
  const checkoutClient = fs.readFileSync('public/js/customer-checkout.js', 'utf8');
  const lifecycle = fs.readFileSync('src/payments/lifecycle.js', 'utf8');
  const pending = fs.readFileSync('src/security/pending-registration.js', 'utf8');
  const provisioning = fs.readFileSync('src/jellyfin/provisioning-helpers.js', 'utf8');
  const checkoutIntents = fs.readFileSync('src/payments/checkout-intents.js', 'utf8');
  const lifecyclePrimitives = fs.readFileSync('src/payments/lifecycle-primitives.js', 'utf8');
  const planChange = fs.readFileSync('src/payments/customer-plan-change.js', 'utf8');
  const userCapacity = fs.readFileSync('src/jellyfin/user-capacity.js', 'utf8');
  const mediaReconcile = fs.readFileSync('src/jellyfin/media-service-reconciliation.js', 'utf8');
  const providerRecovery = fs.readFileSync('src/payments/provider-operation-recovery.js', 'utf8');
  const adminServers = fs.readFileSync('src/platform/admin-servers.js', 'utf8');
  const migration = fs.readFileSync('db/migrations/20261003113000_customer_media_location_assignment.sql', 'utf8');
  assert(checkout.includes('mediaLocation:choice.mediaLocation||null'), 'paid checkout contract must freeze the chosen location');
  assert(lifecycle.includes('media_location_preference') && lifecycle.includes('resolveAcquisitionLocation'), 'Free and trial acquisition must persist a location preference before provisioning');
  assert(pending.includes('freeMediaLocation') && pending.includes('media_location,media_server_id'), 'pre-login Free registration must persist its selected location and concrete server');
  assert(provisioning.includes('assignedServer'), 'Jellyfin provisioning must honor sticky subscription assignment before considering fresh placement');
  assert(mediaReconcile.includes('persistAssignment') && mediaReconcile.includes('assignedServer'), 'Emby/Jellyfin service reconciliation must use sticky assignment');
  assert(migration.includes('ADD COLUMN IF NOT EXISTS media_server_id') && migration.includes('ON DELETE RESTRICT'), 'assignment schema must preserve server references and block destructive deletion');
  assert(!migration.includes('\n$;\n'), 'PostgreSQL migration DO blocks must never contain a single-dollar terminator; every DO block must close with its matching dollar-quote delimiter.');
  assert(migration.includes('billing_checkout_intents') && migration.includes('free_access_registration_reservations'), 'paid checkout and Free registration must reserve exact physical server capacity');
  assert(migration.includes('matching_account_count=1'), 'legacy subscription assignment backfill must leave ambiguous multi-account customers untouched');
  assert(checkoutIntents.includes('selectServerForLocationLocked') && checkoutIntents.includes('media_server_id'), 'paid checkout must serialize and reserve a concrete physical server');
  assert(lifecycle.includes('selectServerForLocationLocked'), 'Free and trial activation must serialize concrete server selection');
  assert(lifecyclePrimitives.includes('selectServerForLocationLocked'), 'paid settlement fallback must serialize server reselection inside the chosen location');
  assert(checkout.includes('mediaLocation:choice.mediaLocation||null'), 'recurring checkout must forward the chosen media location into the plan-change workflow');
  assert(dashboard.includes('selectedLocation') && dashboard.includes('existingAssignment:true') && dashboard.includes('safeTestUrl(assigned)'), 'customer location discovery must preserve an existing eligible assignment, including its safe performance-test URL, even when its physical server is full');
  assert(checkoutClient.includes('payload.selectedLocation') && checkoutClient.includes('setMediaLocation(card,preferred)'), 'checkout UI must preselect a reusable existing location without removing the customer choice');
  assert(planChange.includes('reservedServerIfEligible(target,current.media_server_id,mediaLocation||null)'), 'plan changes must reuse an eligible current server before applying new-customer availability rules');
  assert(planChange.includes('target_media_location') && planChange.includes('media_location_preference=$13') && planChange.includes('media_server_id=$14'), 'plan changes must persist their target location and concrete sticky assignment');
  assert(planChange.includes('change.target_media_location') && planChange.includes('reservedServerIfEligible') && planChange.includes('selectServerForLocationLocked'), 'scheduled plan changes must revalidate their chosen location under row locks and reuse the old server only when it remains eligible');
  assert(migration.includes('ALTER TABLE customer_plan_changes') && migration.includes('target_media_location'), 'scheduled plan changes must retain their target media location across provider renewal boundaries');
  assert(userCapacity.includes('checkout.media_server_id IS NULL') && userCapacity.includes('reservation.media_server_id IS NULL'), 'N-1 generic checkout/free holds must conservatively protect physical server capacity during rolling deploys');
  assert(userCapacity.includes('customer_plan_changes change') && userCapacity.includes("change.provider='stripe'") && userCapacity.includes("change.state='pending'"), 'scheduled Stripe plan changes must remain durable physical-capacity reservations until applied or cancelled');
  assert(userCapacity.includes('provider_operations operation') && userCapacity.includes("operation.operation_type='plan_change_immediate'") && userCapacity.includes("operation.state IN('planned','provider_applied','local_applied')"), 'immediate Stripe provider recovery must retain the promised target-server capacity after short leases expire');
  assert(lifecyclePrimitives.includes('committedReservedServer') && lifecyclePrimitives.includes('media_server_unavailable_after_provider_settlement'), 'paid settlement must honor the exact server reserved before payment and surface any remaining media failure as paid-but-unfulfilled');
  assert(planChange.includes('targetMediaLocation:mediaLocation||null') && planChange.includes('targetMediaServerId:mediaServer?.id||null'), 'immediate Stripe recovery snapshots must retain the paid target media assignment');
  assert(planChange.includes("recorded?.state==='failed'&&recorded?.failure_kind==='terminal'") && planChange.includes("(!providerMutationAttempted||terminal)&&placementReservation?.placement_lease_id"), 'immediate Stripe changes must release capacity only for pre-provider or definitively rejected operations while retaining it across ambiguous/provider-applied recovery');
  assert(planChange.includes('reserveScheduledMediaPlacement') && planChange.includes('target_media_server_id'), 'period-end Stripe changes must reserve and persist their future media server through renewal');
  assert(providerRecovery.includes('request.targetMediaLocation') && providerRecovery.includes('request.targetMediaServerId'), 'provider-operation recovery must restore location/server assignment after provider-success/local-failure');
  assert(provisioning.includes('SELECT 1 FROM subscriptions') && provisioning.includes('media_server_id=$2'), 'provisioning capacity checks must recognize the customer\'s own active subscription reservation');
  assert(migration.includes('target_media_server_id') && migration.includes('customer_plan_changes_target_media_server_id_fkey'), 'scheduled paid media reservations must survive process restarts and block destructive server deletion');
  assert(adminServers.includes('providerChanged&&occupied>0'), 'server provider conversion must be blocked while paid/free customer capacity is occupied or reserved');
  assert(fs.readFileSync('src/jellyfin/customer-server-choice.js','utf8').includes('$4::boolean OR media_location_preference'), 'explicit admin migration must overwrite the sticky location preference together with the server assignment');

  console.log('customer media location selection smoke: ok');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
