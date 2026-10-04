'use strict';
// Exact-head regression audit trigger: 2026-10-04; no production behavior change.

const assert = require('assert');
const fs = require('fs');
const choice = require('../src/jellyfin/customer-server-choice');
const customerMediaAccess = require('../src/access/customer-media-access');
const resilientProvisioning = require('../src/jellyfin/resilient-provisioning');
const mediaServiceReconciliation = require('../src/jellyfin/media-service-reconciliation');
const customerAccessState = require('../src/access/customer-access-state');
const planServers = require('../src/jellyfin/plan-servers');

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

function fakeDb({ fullGermany = false, disabledAssigned = false, fullServerIds = [] } = {}) {
  const fullIds = new Set([
    ...fullServerIds.map(String),
    ...(fullGermany ? [String(servers[2].id)] : [])
  ]);
  return async (sql, params = []) => {
    if (sql.includes("setting_key='operations_v1'")) {
      return { rowCount: 1, rows: [{ setting_value: { placementHealthMode: 'healthy_or_degraded' } }] };
    }
    if (sql.includes('WITH restriction AS')) {
      return { rowCount: servers.length, rows: servers.map(server => ({ ...server, placement_weight: 100 })) };
    }
    if (sql.includes('WITH capacity_users AS')) {
      const rows = servers
        .filter(server => fullIds.has(String(server.id)))
        .map(server => ({ server_id: server.id, users: Number(server.max_users || 0) }));
      return { rowCount: rows.length, rows };
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
  const publicResolver = async () => ['1.1.1.1'];
  assert.strictEqual(choice.locationLabel('  London   '), 'London');
  assert.strictEqual(choice.locationLabel(''), 'Default');
  assert.strictEqual(choice.matchesPreference({ location: ' london ' }, 'London'), true);
  assert.strictEqual(choice.matchesPreference({ location: 'Germany' }, 'London'), false);
  assert(await choice.safeTestUrl(servers[0], { resolveHost: publicResolver }).then(Boolean), 'public media URLs must remain available for browser latency tests');
  assert.strictEqual(await choice.safeTestUrl(servers[0], { resolveHost: async () => ['10.0.0.5'] }), null, 'private media destinations must never be exposed as customer latency-test URLs');
  assert.strictEqual(await choice.safeTestUrl(servers[0], { resolveHost: async () => ['127.0.0.1'] }), null, 'loopback media destinations must never be exposed as customer latency-test URLs');
  assert.strictEqual(choice.mediaServerType({ service_type: 'bundle' }), 'jellyfin');
  assert.strictEqual(choice.mediaServerType({ service_type: 'emby' }), 'emby');
  assert.strictEqual(choice.mediaServerType({ service_type: 'stremio' }), null);

  const originalEligibleServersForPlan = planServers.eligibleServersForPlan;
  try {
    planServers.eligibleServersForPlan = async () => [{ id: 'explicit-custom-server' }];
    const scopedLegacyEntitlement = await customerAccessState.withPlacementScope({
      id: 'legacy-plan',
      service_type: 'jellyfin',
      server_class: 'premium'
    });
    assert.deepStrictEqual(scopedLegacyEntitlement.eligible_server_ids, ['explicit-custom-server'],
      'canonical access state must resolve the actual explicit plan pool before legacy readiness classification');
    assert.strictEqual(customerAccessState.accountMatchesEntitlement({
      server_id: 'explicit-custom-server',
      server_class: 'custom',
      access_lane: 'primary',
      disabled: false,
      server_enabled: true
    }, scopedLegacyEntitlement, 'primary'), true,
    'explicit pool membership must beat a legacy server_class mismatch');
    assert.strictEqual(customerAccessState.accountMatchesEntitlement({
      server_id: 'same-class-but-not-selected',
      server_class: 'premium',
      access_lane: 'primary',
      disabled: false,
      server_enabled: true
    }, scopedLegacyEntitlement, 'primary'), false,
    'same-class accounts outside an explicit pool must not satisfy canonical access state');
  } finally {
    planServers.eligibleServersForPlan = originalEligibleServersForPlan;
  }

  const embyEntitlement = { subscription_id: 'emby-sub', media_server_id: 'emby-server-current' };
  const currentEmbyAccount = { id: 'emby-account-current', server_id: 'emby-server-current', media_server_type: 'emby', disabled: false, server_enabled: true };
  const staleEmbyAccount = { id: 'emby-account-stale', server_id: 'emby-server-old', media_server_type: 'emby', disabled: false, server_enabled: true };
  const embyContext = {
    accounts: [currentEmbyAccount, staleEmbyAccount],
    accessSnapshot: { emby: { entitlement: embyEntitlement } }
  };
  assert.strictEqual(
    customerMediaAccess.entitlementForAccountFromContext(currentEmbyAccount, embyContext),
    embyEntitlement,
    'the Emby account on the persisted subscription server must retain credential access'
  );
  assert.strictEqual(
    customerMediaAccess.entitlementForAccountFromContext(staleEmbyAccount, embyContext),
    null,
    'a stale Emby account on another server must not inherit the current subscription entitlement'
  );
  const legacyEmbyEntitlement = { subscription_id: 'legacy-emby-sub', media_server_id: null };
  assert.strictEqual(
    customerMediaAccess.entitlementForAccountFromContext(currentEmbyAccount, {
      accounts: [currentEmbyAccount],
      accessSnapshot: { emby: { entitlement: legacyEmbyEntitlement } }
    }),
    legacyEmbyEntitlement,
    'one unambiguous legacy Emby account may remain manageable before assignment backfill'
  );
  assert.strictEqual(
    customerMediaAccess.entitlementForAccountFromContext(currentEmbyAccount, {
      accounts: [currentEmbyAccount, staleEmbyAccount],
      accessSnapshot: { emby: { entitlement: legacyEmbyEntitlement } }
    }),
    null,
    'ambiguous legacy Emby accounts must fail closed until a server assignment is repaired'
  );

  const jellyfinEntitlement = { subscription_id: 'jellyfin-sub', media_server_id: 'jellyfin-server-current', server_class: 'premium' };
  const currentJellyfinAccount = {
    id: 'jellyfin-account-current',
    server_id: 'jellyfin-server-current',
    media_server_type: 'jellyfin',
    access_lane: 'primary',
    server_class: 'premium',
    disabled: false,
    server_enabled: true
  };
  const staleJellyfinAccount = {
    id: 'jellyfin-account-stale',
    server_id: 'jellyfin-server-old',
    media_server_type: 'jellyfin',
    access_lane: 'primary',
    server_class: 'premium',
    disabled: false,
    server_enabled: true
  };
  const jellyfinContext = {
    accounts: [currentJellyfinAccount, staleJellyfinAccount],
    accessSnapshot: { primary: { entitlement: jellyfinEntitlement } }
  };
  assert.strictEqual(
    customerMediaAccess.entitlementForAccountFromContext(currentJellyfinAccount, jellyfinContext),
    jellyfinEntitlement,
    'the Jellyfin account on the persisted subscription server must retain credential access'
  );
  assert.strictEqual(
    customerMediaAccess.entitlementForAccountFromContext(staleJellyfinAccount, jellyfinContext),
    null,
    'a stale Jellyfin account on another server must not inherit the current subscription entitlement'
  );
  assert.strictEqual(
    resilientProvisioning.unambiguousLegacyAccount([currentJellyfinAccount], 'primary Jellyfin'),
    currentJellyfinAccount,
    'one legacy Jellyfin account may be adopted as the sticky assignment'
  );
  assert.throws(
    () => resilientProvisioning.unambiguousLegacyAccount([currentJellyfinAccount, staleJellyfinAccount], 'primary Jellyfin'),
    error => error.code === 'AMBIGUOUS_LEGACY_MEDIA_ASSIGNMENT',
    'central Jellyfin reconciliation must not guess between multiple legacy accounts'
  );
  assert.strictEqual(
    mediaServiceReconciliation.unambiguousLegacyAccount([currentEmbyAccount], 'Emby'),
    currentEmbyAccount,
    'one legacy Emby account may be adopted as the sticky assignment'
  );
  assert.throws(
    () => mediaServiceReconciliation.unambiguousLegacyAccount([currentEmbyAccount, staleEmbyAccount], 'Emby'),
    error => error.code === 'AMBIGUOUS_LEGACY_MEDIA_ASSIGNMENT',
    'central Emby reconciliation must not guess between multiple legacy accounts'
  );

  const legacyJellyfinEntitlement = { subscription_id: 'legacy-jellyfin-sub', media_server_id: null, server_class: 'premium' };
  assert.strictEqual(
    customerMediaAccess.entitlementForAccountFromContext(currentJellyfinAccount, {
      accounts: [currentJellyfinAccount, staleJellyfinAccount],
      accessSnapshot: { primary: { entitlement: legacyJellyfinEntitlement } }
    }),
    null,
    'ambiguous legacy Jellyfin accounts must fail closed until a server assignment is repaired'
  );

  const grouped = await choice.choicesForPlan(plan, { db: fakeDb(), resolveTestHost: publicResolver });
  assert.strictEqual(grouped.length, 2, 'two distinct locations must produce two customer choices');
  assert.strictEqual(grouped.find(item => item.value === 'London').serverCount, 2, 'same-location servers must be grouped behind one customer choice');
  assert.strictEqual(grouped.find(item => item.value === 'London').remaining, 20);
  assert.strictEqual(grouped.find(item => item.value === 'Germany').remaining, 5);
  await assert.rejects(() => choice.resolveAcquisitionLocation(plan, null, { db: fakeDb(), requireSelection: true }), /Choose a server location/);
  assert.strictEqual(await choice.resolveAcquisitionLocation(plan, 'gErMaNy', { db: fakeDb(), requireSelection: true }), 'Germany');

  const withFullGermany = await choice.choicesForPlan(plan, { db: fakeDb({ fullGermany: true }), resolveTestHost: publicResolver });
  assert.deepStrictEqual(withFullGermany.map(item => item.value), ['London'], 'full locations must not be offered to new placements');
  assert.strictEqual(await choice.resolveAcquisitionLocation(plan, null, { db: fakeDb({ fullGermany: true }), requireSelection: true }), 'London', 'single remaining location must auto-select without a dropdown');
  const existingFullGermany = await choice.existingAssignedServerForPlan(plan, servers[2].id, 'Germany', { db: fakeDb({ fullGermany: true }) });
  assert.strictEqual(existingFullGermany.id, servers[2].id, 'an existing paid assignment may remain on its already-occupied full server during a plan change');

  const stickyCurrent = { ...plan, plan_id: plan.id, media_server_id: servers[0].id };
  const noPoolLookupDbBase = fakeDb();
  const noPoolLookupDb = async (sql, params = []) => {
    if (sql.includes('WITH restriction AS')) throw new Error('same-plan sticky reuse must not consult the new-placement pool');
    return noPoolLookupDbBase(sql, params);
  };
  const samePlanSticky = await choice.reusableAssignedServerForPlan(stickyCurrent, plan, null, { db: noPoolLookupDb });
  assert.strictEqual(
    samePlanSticky.id,
    servers[0].id,
    'same-plan stream/variant changes must keep the exact assigned server even after it is removed from the acquisition pool'
  );

  const selected = await choice.selectServerForLocation(plan, 'London', { db: fakeDb() });
  assert(['London A', 'London B'].includes(selected.name), 'location selection must never escape the chosen location');
  const lockedSelected = await choice.selectServerForLocationLocked(plan, 'London', { db: fakeDb() });
  assert(['London A', 'London B'].includes(lockedSelected.name), 'serialized reservation must stay inside the chosen location');

  // The lock set must include currently-full servers in the selected location.
  // They can become available between the pre-lock read and final capacity read;
  // if omitted from FOR UPDATE, the final allocator could select an unlocked slot.
  let lockedCandidateIds = [];
  const partiallyFullDbBase = fakeDb({ fullServerIds: [servers[0].id] });
  const partiallyFullDb = async (sql, params = []) => {
    if (sql.includes('WHERE id=ANY($1::uuid[])') && sql.includes('FOR UPDATE')) {
      lockedCandidateIds = [...(params[0] || [])].map(String);
    }
    return partiallyFullDbBase(sql, params);
  };
  await choice.selectServerForLocationLocked(plan, 'London', { db: partiallyFullDb });
  assert.deepStrictEqual(
    lockedCandidateIds.sort(),
    [servers[0].id, servers[1].id].map(String).sort(),
    'atomic reservation must lock every eligible server in the selected location, including currently-full candidates'
  );

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
  const planChangeSource = fs.readFileSync('src/payments/customer-plan-change.js', 'utf8');
  assert(checkout.includes('reusableAssignedServerForPlan(current,choice.plan,requested)'), 'checkout preflight must preserve same-plan sticky media assignment');
  assert(dashboard.includes('reusableAssignedServerForPlan(current,plan,null)'), 'dashboard location state must preserve the current plan sticky assignment');
  assert(planChangeSource.includes('reusableAssignedServerForPlan(current,target,mediaLocation||null)'), 'plan-change execution must not silently migrate same-plan customers');
  const checkoutClient = fs.readFileSync('public/js/customer-checkout.js', 'utf8');
  const lifecycle = fs.readFileSync('src/payments/lifecycle.js', 'utf8');
  const pending = fs.readFileSync('src/security/pending-registration.js', 'utf8');
  const provisioning = fs.readFileSync('src/jellyfin/provisioning-helpers.js', 'utf8');
  const checkoutIntents = fs.readFileSync('src/payments/checkout-intents.js', 'utf8');
  const lifecyclePrimitives = fs.readFileSync('src/payments/lifecycle-primitives.js', 'utf8');
  const planChange = fs.readFileSync('src/payments/customer-plan-change.js', 'utf8');
  const subscriptionActions = fs.readFileSync('src/platform/customer-subscription-actions.js', 'utf8');
  const billingControl = fs.readFileSync('src/payments/billing-control.js', 'utf8');
  const subscriptionTermination = fs.readFileSync('src/payments/subscription-termination.js', 'utf8');
  const userCapacity = fs.readFileSync('src/jellyfin/user-capacity.js', 'utf8');
  const mediaReconcile = fs.readFileSync('src/jellyfin/media-service-reconciliation.js', 'utf8');
  const providerRecovery = fs.readFileSync('src/payments/provider-operation-recovery.js', 'utf8');
  const adminServers = fs.readFileSync('src/platform/admin-servers.js', 'utf8');
  const migration = fs.readFileSync('db/migrations/20261003113000_customer_media_location_assignment.sql', 'utf8');
  const application = fs.readFileSync('src/application.js', 'utf8');
  const registerView = fs.readFileSync('views/customer/register.ejs', 'utf8');
  const registrationProbe = fs.readFileSync('public/js/media-location-test.js', 'utf8');
  const customerJellyfin = fs.readFileSync('src/platform/customer-jellyfin.js', 'utf8');
  const userImport = fs.readFileSync('src/jellyfin/user-import.js', 'utf8');
  const driftControl = fs.readFileSync('src/jellyfin/drift-control.js', 'utf8');
  assert(checkout.includes('mediaLocation:choice.mediaLocation||null'), 'paid checkout contract must freeze the chosen location');
  assert(checkout.includes('reusableAssignedServerForPlan(current,choice.plan,requested)'), 'paid checkout validation must preserve an existing same-plan customer on their already-occupied sticky server even when it is full, drained, or removed from the new-placement pool');
  assert(lifecycle.includes('media_location_preference') && lifecycle.includes('resolveAcquisitionLocation'), 'Free and trial acquisition must persist a location preference before provisioning');
  assert(lifecycle.includes("mediaType==='emby'") && lifecycle.includes('readyEmbyAccountForSubscription') && lifecycle.includes('rollbackUnprovisionedEmbyTrial') && lifecycle.includes("failureCode:'TRIAL_EMBY_PROVISIONING_FAILED'"), 'Emby trials must use the same strict provision-or-rollback invariant as Jellyfin trials');
  assert(pending.includes('freeMediaLocation') && pending.includes('media_location,media_server_id'), 'pre-login Free registration must persist its selected location and concrete server');
  assert(provisioning.includes('assignedServer'), 'Jellyfin provisioning must honor sticky subscription assignment before considering fresh placement');
  assert(mediaReconcile.includes('persistAssignment') && mediaReconcile.includes('assignedServer'), 'Emby/Jellyfin service reconciliation must use sticky assignment');
  assert(provisioning.includes("unambiguousLegacyAccount(outsidePrimary, 'Free-adoption')"), 'legacy Free-lane adoption must not guess between multiple eligible old accounts');
  assert(migration.includes('ADD COLUMN IF NOT EXISTS media_server_id') && migration.includes('ON DELETE RESTRICT'), 'assignment schema must preserve server references and block destructive deletion');
  assert(!migration.includes('\n$;\n'), 'PostgreSQL migration DO blocks must never contain a single-dollar terminator; every DO block must close with its matching dollar-quote delimiter.');
  assert(migration.includes('billing_checkout_intents') && migration.includes('free_access_registration_reservations'), 'paid checkout and Free registration must reserve exact physical server capacity');
  assert(migration.includes('matching_account_count=1'), 'legacy subscription assignment backfill must leave ambiguous multi-account customers untouched');
  assert(checkoutIntents.includes('selectServerForLocationLocked') && checkoutIntents.includes('media_server_id'), 'paid checkout must serialize and reserve a concrete physical server');
  assert(checkoutIntents.includes('jellyfin_server_placement_leases') && checkoutIntents.includes("INTERVAL '15 minutes'"), 'paid checkout must expose a short compatibility reservation to N-1 web capacity accounting during rolling deployment');
  assert(lifecycle.includes('selectServerForLocationLocked'), 'Free and trial activation must serialize concrete server selection');
  assert(lifecyclePrimitives.includes('selectServerForLocationLocked'), 'paid settlement fallback must serialize server reselection inside the chosen location');
  assert(checkout.includes('mediaLocation:choice.mediaLocation||null'), 'recurring checkout must forward the chosen media location into the plan-change workflow');
  assert(dashboard.includes('selectedLocation') && dashboard.includes('existingAssignment:true') && dashboard.includes('reusableAssignedServerForPlan') && dashboard.includes('safeTestUrl(assigned)'), 'customer location discovery must preserve the current-plan sticky assignment, including its safe performance-test URL, even when its physical server is full or no longer accepts new placements');
  assert(dashboard.includes('entitlement.admin_forced_server_id||entitlement.media_server_id') && dashboard.includes('enabled.length===1') && dashboard.includes('candidates.length===1'), 'Account Home onboarding must use the persisted Jellyfin server assignment and fail closed for ambiguous legacy same-lane accounts');
  assert(checkoutClient.includes('payload.selectedLocation') && checkoutClient.includes('setMediaLocation(card,preferred)'), 'checkout UI must preselect a reusable existing location without removing the customer choice');
  assert(application.includes("connect-src 'self' https: http:") && application.includes("script-src 'self'"), 'customer latency probes must be allowed to configured http/https media origins without relaxing script execution beyond same-origin');
  assert(registerView.includes('data-media-location-test') && registerView.includes('data-test-media-locations') && registerView.includes('/js/media-location-test.js'), 'Free signup with multiple locations must expose the customer latency-test control');
  assert(customerJellyfin.includes('if(!entitlement)continue;'), 'My Access must not render orphan/stale media accounts that no longer match a current entitlement');
  assert(userImport.includes('media_location_preference,media_server_id,media_location_snapshot'), 'Admin-created imported subscriptions must persist the exact media server assignment immediately.');
  assert(userImport.includes('This subscription is already assigned to a different media server.'), 'Link-existing-user repair must not silently move a subscription to another physical server.');
  assert(userImport.includes('media_server_id=COALESCE(media_server_id,$2)') && userImport.includes('(media_server_id IS NULL OR media_server_id=$2)'), 'Legacy link repair must atomically adopt a missing subscription server assignment without overwriting a concurrent assignment.');
  assert(userImport.includes('eligibleServersForPlan(plan, { enabledOnly: true, forPlacement })') && !userImport.includes('String(server.server_class) !== String(plan.server_class)'), 'Explicit plan server pools must remain authoritative for imports instead of being rejected by the legacy server-class shortcut.');
  assert(driftControl.includes('entitlement.media_server_id') && driftControl.includes('String(a.server_id)===assignedServerId'), 'policy-drift automation must resolve the persisted assigned server before falling back to legacy server_class matching');
  assert(registrationProbe.includes("mode:'no-cors'") && registrationProbe.includes("credentials:'omit'") && registrationProbe.includes("referrerPolicy:'no-referrer'") && registrationProbe.includes("reason:'Unavailable'"), 'Free signup latency probes must be credential-free, referrer-free and report failed tests as unavailable');
  assert(planChange.includes('reusableAssignedServerForPlan(current,target,mediaLocation||null)'), 'plan changes must reuse the current sticky server for same-plan changes and only apply target-pool eligibility when moving to a different plan');
  assert(planChange.includes('assertNoAmbiguousLegacyMediaAssignment') && planChange.includes('needs administrator repair before this paid plan change can be made safely'), 'paid plan changes must fail closed when a legacy customer has media accounts but no unambiguous persisted server assignment');
  assert(subscriptionActions.includes("if(!enable&&await planChange.pendingForCustomer") && subscriptionActions.includes('Cancel your scheduled plan change before stopping automatic renewal.'), 'renewal stop must not race an open scheduled plan change or leave its future commercial reservation ambiguous');
  assert(billingControl.includes("FROM customer_plan_changes") && billingControl.includes("state IN('pending','awaiting_checkout')") && billingControl.includes('Cancel the scheduled plan change before stopping automatic renewal.'), 'central renewal control must enforce the scheduled-plan guard for admin and customer callers alike');
  assert(subscriptionTermination.includes("UPDATE customer_plan_changes") && subscriptionTermination.includes("state='cancelled'") && subscriptionTermination.includes("current_subscription_id=$1"), 'hard subscription termination/refund must retire pending plan changes so future plan/server capacity is released');
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
  assert(adminServers.includes('assertPublicCustomerUrl') && adminServers.includes('outbound.resolveHost') && adminServers.includes('info.hard || info.private'), 'admin server saves must reject customer/public URLs that resolve to private or reserved network destinations');
  assert(fs.readFileSync('src/jellyfin/customer-server-choice.js','utf8').includes('$4::boolean OR media_location_preference'), 'explicit admin migration must overwrite the sticky location preference together with the server assignment');

  console.log('customer media location selection smoke: ok');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
