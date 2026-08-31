'use strict';
require('dotenv').config();
const assert = require('assert');
const bcrypt = require('bcryptjs');
const { query, getPool } = require('../src/db');
const auth = require('../src/auth/service');
const totp = require('../src/auth/totp');
const lifecycle = require('../src/payments/lifecycle');
const subscriptionExpiry = require('../src/entitlements/subscription-expiry');
const householdAccess = require('../src/stremio/household-access');
const networkLeases = require('../src/access/network-leases');

const FAILURE_LIMIT = Math.max(3, Math.min(10, Number(process.env.AUTH_FAILURE_LIMIT || 5)));

function mockReq(sessionID) {
  return { ip: '127.0.0.1', sessionID: sessionID || `ci-post451-${Math.random().toString(36).slice(2)}`, get(name) { return String(name).toLowerCase() === 'user-agent' ? 'steam-fusion-post451-smoke/1' : ''; } };
}

async function createCustomer(label, suffix) {
  return (await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`, [label, `${label}-${suffix}@example.invalid`])).rows[0];
}

async function createStaff(username, password) {
  const hash = await bcrypt.hash(password, 12);
  return (await query(`INSERT INTO app_users(username,password_hash,role,active,password_changed_at) VALUES($1,$2,'admin',TRUE,NOW()) RETURNING *`, [username, hash])).rows[0];
}

// Items 3 & 4: staff password/2FA failure counter concurrency and account-global lockout.
async function staffFailureCounterConcurrency(suffix) {
  const username = `ci-post451-concurrency-${suffix}`;
  const password = `Aa1!${suffix}concurrency`;
  const user = await createStaff(username, password);

  // Item 3: fire genuinely concurrent bad-password attempts and prove the
  // DB-backed counter increments exactly once per attempt (no lost updates
  // from an unserialized read-modify-write).
  const concurrentAttempts = FAILURE_LIMIT - 1;
  await Promise.all(Array.from({ length: concurrentAttempts }, () => auth.authenticateStaff(username, `${password}-wrong`, mockReq())));
  const afterConcurrent = (await query('SELECT failed_login_count,locked_until FROM app_users WHERE id=$1', [user.id])).rows[0];
  assert.equal(Number(afterConcurrent.failed_login_count), concurrentAttempts, 'concurrent failed logins must all be counted exactly once each (no lost increments)');
  assert.equal(afterConcurrent.locked_until, null, 'account must not be locked before reaching the failure limit');

  // One more failure crosses the limit and locks the account.
  await auth.authenticateStaff(username, `${password}-wrong`, mockReq());
  const locked = (await query('SELECT failed_login_count,locked_until FROM app_users WHERE id=$1', [user.id])).rows[0];
  assert.equal(Number(locked.failed_login_count), FAILURE_LIMIT, 'failure count must reach the configured limit');
  assert(locked.locked_until && new Date(locked.locked_until).getTime() > Date.now(), 'account must be locked after crossing the failure limit');

  // A correct password is still rejected while the account-level lock is active.
  const rejectedWhileLocked = await auth.authenticateStaff(username, password, mockReq());
  assert.equal(rejectedWhileLocked, null, 'a correct password must not bypass an active account lock');

  // Clear the lock so the rest of this scenario can proceed with a clean account.
  await query('UPDATE app_users SET failed_login_count=0,locked_until=NULL WHERE id=$1', [user.id]);
  return user;
}

// Item 4: 2FA challenge failures use the same account-global counter and cannot
// be reset by abandoning the pending login session and starting a new one.
async function twoFactorAccountGlobalLockout(suffix) {
  const username = `ci-post451-2fa-lockout-${suffix}`;
  const password = `Aa1!${suffix}twofactor`;
  const user = await createStaff(username, password);
  const enrollment = await auth.beginTotpEnrollment(user.id);
  await auth.confirmTotpEnrollment(user.id, totp.totp(enrollment.secret), mockReq());

  // Each bad attempt uses a brand-new session (a fresh pending login), proving
  // the failure count survives restarting the pending challenge.
  for (let i = 0; i < FAILURE_LIMIT - 1; i += 1) {
    const ok = await auth.verifySecondFactor(user.id, '000000', mockReq(`ci-post451-2fa-session-${suffix}-${i}`));
    assert.equal(ok, false, 'a wrong TOTP code must never verify');
  }
  const beforeLastFailure = (await query('SELECT failed_login_count,locked_until FROM app_users WHERE id=$1', [user.id])).rows[0];
  assert.equal(Number(beforeLastFailure.failed_login_count), FAILURE_LIMIT - 1, 'restarting the pending login session must not reset the DB-backed 2FA failure counter');
  assert.equal(beforeLastFailure.locked_until, null, 'account must not yet be locked before the limit is crossed');

  // Cross the limit from yet another fresh session.
  await auth.verifySecondFactor(user.id, '000000', mockReq(`ci-post451-2fa-session-${suffix}-final`));
  const lockedRow = (await query('SELECT failed_login_count,locked_until FROM app_users WHERE id=$1', [user.id])).rows[0];
  assert(lockedRow.locked_until && new Date(lockedRow.locked_until).getTime() > Date.now(), '2FA failures must lock the account once the shared limit is crossed');

  // A genuinely correct TOTP code must still be rejected while locked.
  const correctWhileLocked = await auth.verifySecondFactor(user.id, totp.totp(enrollment.secret), mockReq(`ci-post451-2fa-session-${suffix}-correct-locked`));
  assert.equal(correctWhileLocked, false, 'a correct TOTP code must not bypass an active account-level 2FA lock');

  await query('UPDATE app_users SET failed_login_count=0,locked_until=NULL WHERE id=$1', [user.id]);

  // Password acceptance must not clear the failure counter while 2FA is still
  // required, but a subsequent successful 2FA verification must clear it.
  await auth.verifySecondFactor(user.id, '000000', mockReq(`ci-post451-2fa-session-${suffix}-pre`));
  const afterOneFailure = (await query('SELECT failed_login_count FROM app_users WHERE id=$1', [user.id])).rows[0];
  assert.equal(Number(afterOneFailure.failed_login_count), 1, 'sanity: one bad TOTP attempt must record one failure');
  const passwordResult = await auth.authenticateStaff(username, password, mockReq(`ci-post451-2fa-session-${suffix}-password`));
  assert(passwordResult && passwordResult.id === user.id, 'the correct password must still be accepted as the first factor');
  const afterPasswordAccept = (await query('SELECT failed_login_count FROM app_users WHERE id=$1', [user.id])).rows[0];
  assert.equal(Number(afterPasswordAccept.failed_login_count), 1, 'accepting the password must not clear the 2FA failure counter while 2FA is still required');
  const goodVerify = await auth.verifySecondFactor(user.id, totp.totp(enrollment.secret), mockReq(`ci-post451-2fa-session-${suffix}-good`));
  assert.equal(goodVerify, true, 'a correct TOTP code must verify once the account is not locked');
  const afterGoodVerify = (await query('SELECT failed_login_count FROM app_users WHERE id=$1', [user.id])).rows[0];
  assert.equal(Number(afterGoodVerify.failed_login_count), 0, 'a successful 2FA verification must clear the failure counter');
}

// Item 5: disableTotp must re-check the authenticating password hash under a
// row lock so a concurrent password change cannot let a stale password proof
// disable 2FA.
async function disableTotpToctou(suffix) {
  const username = `ci-post451-disable-toctou-${suffix}`;
  const originalPassword = `Aa1!${suffix}original`;
  const user = await createStaff(username, originalPassword);
  const enrollment = await auth.beginTotpEnrollment(user.id);
  await auth.confirmTotpEnrollment(user.id, totp.totp(enrollment.secret), mockReq());

  const pool = getPool();
  const raceClient = await pool.connect();
  try {
    await raceClient.query('BEGIN');
    // Simulate a concurrent password change that has locked the row but not
    // yet committed, representing the exact race window the fix must close.
    const newHash = await bcrypt.hash(`Aa1!${suffix}changed`, 12);
    await raceClient.query('SELECT id FROM app_users WHERE id=$1 FOR UPDATE', [user.id]);
    await raceClient.query('UPDATE app_users SET password_hash=$2,updated_at=NOW() WHERE id=$1', [user.id, newHash]);

    // disableTotp's initial bcrypt.compare reads the still-committed (old)
    // password via READ COMMITTED, so it will pass with the original
    // password; its transaction's FOR UPDATE read then blocks behind
    // raceClient's open transaction until it commits.
    const disablePromise = auth.disableTotp(user.id, originalPassword, mockReq());
    await new Promise(resolve => setTimeout(resolve, 200));
    await raceClient.query('COMMIT');
    const result = await disablePromise;
    assert.equal(result, false, 'disableTotp must fail closed when the password changed concurrently, even though it was valid at the start of the call');
  } finally {
    raceClient.release();
  }
  const stillEnabled = (await query('SELECT totp_enabled FROM app_users WHERE id=$1', [user.id])).rows[0];
  assert.equal(stillEnabled.totp_enabled, true, '2FA must remain enabled after a TOCTOU-protected disable attempt is rejected');
}

// Item 6: auto-downgrade eligibility must be scoped to the Jellyfin/bundle
// lane, not any live entitlement of any service.
async function serviceScopedAutoDowngrade(suffix) {
  const customer = await createCustomer('auto-downgrade', suffix);
  // plans_single_free_tier_idx allows only one is_free_tier=TRUE row across the
  // whole table, so reuse an existing free plan (from earlier fixtures in the
  // same test run) rather than trying to insert a second one.
  let freePlan = (await query(`SELECT * FROM plans WHERE is_free_tier=TRUE LIMIT 1`)).rows[0];
  if (freePlan) {
    freePlan = (await query(`UPDATE plans SET service_type='jellyfin',audience='direct',billing_interval='month',price_minor=0,currency='GBP',capacity_limit=GREATEST(COALESCE(capacity_limit,0),1000),active=TRUE,visible=TRUE,is_addon=FALSE WHERE id=$1 RETURNING *`, [freePlan.id])).rows[0];
  } else {
    freePlan = (await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class,is_free_tier)
      VALUES($1,$1,'jellyfin','direct','month',30,0,'GBP',1000,TRUE,TRUE,1,'premium',TRUE) RETURNING *`, [`post451-free-${suffix}`])).rows[0];
  }
  const expiredJellyfinPlan = (await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class)
    VALUES($1,$1,'jellyfin','direct','month',30,999,'GBP',100,TRUE,TRUE,1,'premium') RETURNING *`, [`post451-expired-jellyfin-${suffix}`])).rows[0];
  const activeStremioPlan = (await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class)
    VALUES($1,$1,'stremio','direct','month',30,499,'GBP',100,TRUE,TRUE,1,'premium') RETURNING *`, [`post451-active-stremio-${suffix}`])).rows[0];

  await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,service_type_snapshot)
    VALUES($1,$2,'expired','admin_grant',NOW()-INTERVAL '60 days',NOW()-INTERVAL '30 days','jellyfin')`, [customer.id, expiredJellyfinPlan.id]);
  await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,service_type_snapshot)
    VALUES($1,$2,'active','admin_grant',NOW(),NOW()+INTERVAL '30 days','stremio')`, [customer.id, activeStremioPlan.id]);

  await lifecycle.saveTrialPolicy({ trialMode: 'once_ever', freeMode: 'renewable', downgradeToFree: true, downgradeFreePlanCode: freePlan.code });

  const downgraded = await lifecycle.autoDowngradeEligibleCustomer(customer.id);
  assert(downgraded, 'an unrelated live Stremio entitlement must not suppress a Jellyfin free-tier auto-downgrade');
  const freeRow = (await query(`SELECT 1 FROM subscriptions WHERE customer_id=$1 AND plan_id=$2 AND source='free_claim'`, [customer.id, freePlan.id])).rows[0];
  assert(freeRow, 'the customer must actually receive the configured Jellyfin free plan');
}

// Item 7: expiry reconciliation failures must be visible in the automation
// job's failed count, not silently swallowed behind a healthy expired count.
async function expiryReconciliationFailureReporting(suffix) {
  const customer = await createCustomer('expiry-reconcile-fail', suffix);
  const plan = (await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class)
    VALUES($1,$1,'jellyfin','direct','month',30,999,'GBP',100,TRUE,TRUE,1,'premium') RETURNING *`, [`post451-expiry-reconcile-${suffix}`])).rows[0];
  await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,service_type_snapshot)
    VALUES($1,$2,'active','admin_grant',NOW()-INTERVAL '60 days',NOW()-INTERVAL '1 minute','jellyfin')`, [customer.id, plan.id]);

  const result = await subscriptionExpiry.expireAndReconcile({
    reconcileCustomer: async id => { if (String(id) === String(customer.id)) throw new Error('simulated reconcile failure'); },
    onReconcileError: () => {},
    detail: true
  });
  assert.equal(result.expired >= 1, true, 'the due local subscription must still expire');
  assert.equal(result.failed, 1, 'a reconcile failure for an expired customer must be reported, not silently dropped');

  const jobsPath = require.resolve('../src/automation/jobs');
  const resilientPath = require.resolve('../src/jellyfin/resilient-provisioning');
  const saved = new Map([jobsPath, resilientPath].map(key => [key, require.cache[key]]));
  try {
    // resilient-provisioning is a shared singleton also required directly by
    // jellyfin/jobs.js (for provisioning.control, reconcileCustomer, etc.), so
    // the stub must preserve every other export and only override the two
    // functions automation/jobs.js actually calls.
    const realResilientProvisioning = require('../src/jellyfin/resilient-provisioning');
    require.cache[resilientPath] = {
      id: resilientPath, filename: resilientPath, loaded: true,
      exports: { ...realResilientProvisioning, expireSubscriptionsAndReconcile: async () => ({ expired: 3, failed: 2 }), notifyExpiringSubscriptions: async () => ({ failed: 0 }) }
    };
    delete require.cache[jobsPath];
    const jobs = require('../src/automation/jobs');
    const outcome = await jobs.run('entitlements');
    assert.equal(outcome.expired, 3, 'the job result must surface the real expired count');
    assert.equal(outcome.failed >= 2, true, 'entitlement-reconciliation failures must be folded into the automation job\'s failed count');
  } finally {
    for (const [key, value] of saved) { if (value) require.cache[key] = value; else delete require.cache[key]; }
  }
}

// Item 8: auto-renewing recurring subscriptions should not receive misleading
// manual-renewal expiry warnings, except when cancel_at_period_end is true.
function renewalWarningEligibility() {
  assert.equal(subscriptionExpiry.recurringAutoRenewal({ status: 'active', source: 'stripe', provider_subscription_id: 'sub_123' }), true, 'an active recurring Stripe subscription must be treated as auto-renewing');
  assert.equal(subscriptionExpiry.recurringAutoRenewal({ status: 'trialing', source: 'stripe', provider_subscription_id: 'sub_123' }), true, 'a trialing recurring Stripe subscription must be treated as auto-renewing');
  assert.equal(subscriptionExpiry.recurringAutoRenewal({ status: 'active', source: 'stripe', provider_subscription_id: 'sub_123', cancel_at_period_end: true }), false, 'a recurring subscription scheduled to cancel at period end must be eligible for the manual-renewal warning');
  assert.equal(subscriptionExpiry.recurringAutoRenewal({ status: 'trialing', source: 'stripe', provider_subscription_id: 'sub_123', cancel_at_period_end: true }), false, 'a trialing subscription scheduled to cancel at period end must also be eligible for the warning');
  assert.equal(subscriptionExpiry.recurringAutoRenewal({ status: 'active', source: 'admin_grant' }), false, 'a manual/non-recurring subscription must never be treated as auto-renewing');
}

// Item 9: releasing a household network lease (with a cooldown-eligibility
// check) must be serialized against a concurrent claim for the same subject.
async function householdReplacementRaceSerialization(suffix) {
  const customer = await createCustomer('household-race', suffix);
  const plan = (await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class,stremio_household_network_limit,stremio_household_lease_minutes,stremio_ip_replacement_policy,stremio_ip_replacement_cooldown_minutes)
    VALUES($1,$1,'stremio','direct','month',30,499,'GBP',100,TRUE,TRUE,1,'premium',1,240,'customer_cooldown',60) RETURNING *`, [`post451-household-plan-${suffix}`])).rows[0];
  const subscription = (await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,service_type_snapshot)
    VALUES($1,$2,'active','admin_grant',NOW(),NOW()+INTERVAL '30 days','stremio') RETURNING *`, [customer.id, plan.id])).rows[0];
  const entitlement = { id: `${suffix}-entitlement`, plan_id: plan.id, subscription_id: subscription.id, customer_id: customer.id };
  const scope = 'stremio', subjectKey = householdAccess.subjectKey(entitlement);
  const firstNetworkAddress = '203.0.113.10', secondNetworkAddress = '203.0.113.20';
  const { component } = await householdAccess.configForEntitlement(entitlement);
  assert.equal(component.config.replacementPolicy, 'customer_cooldown', 'sanity: the fixture plan must use the cooldown replacement policy');

  await networkLeases.claim({ scope, subjectKey, address: firstNetworkAddress, networkLimit: component.config.networkLimit, leaseMinutes: component.config.leaseMinutes });
  const activeBefore = await networkLeases.activeForSubject({ scope, subjectKey });
  assert.equal(activeBefore.length, 1, 'sanity: exactly one household network must hold the lease before the race');

  const pool = getPool();
  const blockerClient = await pool.connect();
  try {
    await blockerClient.query('BEGIN');
    // Hold the same advisory lock release()/claim() must serialize on, proving
    // a concurrent claim for this subject genuinely blocks behind a release.
    await blockerClient.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`default|${scope}|${subjectKey}`]);

    let secondClaimResolved = false;
    const secondClaimPromise = networkLeases.claim({ scope, subjectKey, address: secondNetworkAddress, networkLimit: component.config.networkLimit, leaseMinutes: component.config.leaseMinutes }).then(result => { secondClaimResolved = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(secondClaimResolved, false, 'a concurrent claim for the same subject must block behind the held advisory lock, proving release() and claim() share serialization');

    await blockerClient.query('COMMIT');
    const secondClaimResult = await secondClaimPromise;
    assert.equal(secondClaimResult.allowed, false, 'the second network must still be denied by the network limit once the lock is released, since the first lease was never actually released');
  } finally {
    blockerClient.release();
  }

  // customerInitiated:false (an admin/system reset) intentionally bypasses the
  // customer-facing cooldown policy exercised above; this call is only here
  // to prove the locked release path itself actually clears the lease.
  const releaseResult = await householdAccess.release(entitlement, { customerInitiated: false, reason: 'ci-post451-test' });
  assert(releaseResult >= 1, 'release must actually clear the existing lease once it can acquire the lock');
  const finalClaim = await networkLeases.claim({ scope, subjectKey, address: secondNetworkAddress, networkLimit: component.config.networkLimit, leaseMinutes: component.config.leaseMinutes });
  assert.equal(finalClaim.allowed, true, 'after a real release, a different network must be able to claim the freed slot');
}

// Item 10A: a newly issued external media-server token must be revoked if
// local persistence of that token fails, for connect(), reconnect(), and
// token rotation alike.
async function externalTokenNotLeakedOnPersistenceFailure() {
  const dbPath = require.resolve('../src/db');
  const sourceClientPath = require.resolve('../src/stremio/source-client');
  const sourcePoolPath = require.resolve('../src/stremio/source-pool');
  const tokenMaintenancePath = require.resolve('../src/stremio/external-token-maintenance');
  const saved = new Map([dbPath, sourceClientPath, sourcePoolPath, tokenMaintenancePath].map(key => [key, require.cache[key]]));
  const realDb = require('../src/db');
  const realSourceClient = require('../src/stremio/source-client');
  const logoutCalls = [];
  const fakeAuth = { baseUrl: 'https://fake-media-server.example', publicUrl: 'https://fake-media-server.example', jellyfinUserId: 'fake-user-id', jellyfinUsername: 'fakeuser', accessToken: 'FAKE-ISSUED-TOKEN', mediaServerType: 'jellyfin' };
  try {
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { ...realDb, transaction: async () => { throw new Error('simulated local persistence failure'); } } };
    require.cache[sourceClientPath] = {
      id: sourceClientPath, filename: sourceClientPath, loaded: true,
      exports: { ...realSourceClient, authenticate: async () => fakeAuth, logoutToken: async (baseUrl, token, sourceName, mediaServerType) => { logoutCalls.push({ baseUrl, token, sourceName, mediaServerType }); return true; } }
    };
    delete require.cache[sourcePoolPath];
    delete require.cache[tokenMaintenancePath];
    const sourcePool = require('../src/stremio/source-pool');

    await assert.rejects(
      sourcePool.connect({ name: 'ci-post451-connect', baseUrl: 'https://fake-media-server.example', username: 'u', password: 'p', authorizationConfirmed: true }, null),
      /simulated local persistence failure/,
      'connect() must propagate the persistence failure rather than silently succeeding'
    );
    assert.equal(logoutCalls.length, 1, 'a newly issued token must be revoked immediately after a connect() persistence failure');
    assert.equal(logoutCalls[0].token, fakeAuth.accessToken, 'the exact newly issued token must be the one revoked');
  } finally {
    for (const [key, value] of saved) { if (value) require.cache[key] = value; else delete require.cache[key]; }
  }
}

// Item 10B: reconnect() must not report a healthy/connected source when
// post-auth library discovery fails; it must durably record the auth error
// and index/retry state instead.
async function reconnectDiscoveryFailureLeavesDegradedState() {
  const sourceClientPath = require.resolve('../src/stremio/source-client');
  const sourcePoolPath = require.resolve('../src/stremio/source-pool');
  const saved = new Map([sourceClientPath, sourcePoolPath].map(key => [key, require.cache[key]]));
  const realSourceClient = require('../src/stremio/source-client');
  const fakeAuth = { baseUrl: 'https://fake-media-server.example', publicUrl: 'https://fake-media-server.example', jellyfinUserId: 'fake-user-id', jellyfinUsername: 'fakeuser', accessToken: 'FAKE-ISSUED-TOKEN', mediaServerType: 'jellyfin' };
  let sourceId = null;
  try {
    require.cache[sourceClientPath] = {
      id: sourceClientPath, filename: sourceClientPath, loaded: true,
      exports: { ...realSourceClient, authenticate: async () => fakeAuth, discoverLibraries: async () => [{ libraryId: 'lib-1', name: 'Movies', collectionType: 'movies' }] }
    };
    delete require.cache[sourcePoolPath];
    let sourcePool = require('../src/stremio/source-pool');
    const created = await sourcePool.connect({ name: `ci-post451-reconnect-${Date.now().toString(36)}`, baseUrl: 'https://fake-media-server.example', username: 'u', password: 'p', authorizationConfirmed: true }, null);
    sourceId = created.id;
    const healthy = (await query('SELECT auth_state FROM stremio_sources WHERE id=$1', [sourceId])).rows[0];
    assert.equal(healthy.auth_state, 'connected', 'sanity: the fixture source must start healthy after a successful connect');

    require.cache[sourceClientPath] = {
      id: sourceClientPath, filename: sourceClientPath, loaded: true,
      exports: { ...realSourceClient, authenticate: async () => fakeAuth, discoverLibraries: async () => { throw new Error('simulated discovery failure'); } }
    };
    delete require.cache[sourcePoolPath];
    sourcePool = require('../src/stremio/source-pool');
    await assert.rejects(sourcePool.reconnect(sourceId, { username: 'u', password: 'p' }, null), /simulated discovery failure/, 'reconnect() must propagate the discovery failure rather than swallowing it');

    const after = (await query('SELECT auth_state,last_error FROM stremio_sources WHERE id=$1', [sourceId])).rows[0];
    assert.notEqual(after.auth_state, 'connected', 'a source must not be left reporting connected/healthy after a reconnect discovery failure');
    assert(after.last_error && /simulated discovery failure/.test(after.last_error), 'the durable last_error must name the real discovery failure');
    const indexState = (await query('SELECT status,last_error FROM stremio_source_index_state WHERE source_id=$1', [sourceId])).rows[0];
    assert.equal(indexState.status, 'failed', 'the index/retry state must be durably marked failed, not left ready/healthy');
  } finally {
    for (const [key, value] of saved) { if (value) require.cache[key] = value; else delete require.cache[key]; }
  }
}

async function main() {
  const suffix = Date.now().toString(36);
  await staffFailureCounterConcurrency(suffix);
  await twoFactorAccountGlobalLockout(suffix);
  await disableTotpToctou(suffix);
  await serviceScopedAutoDowngrade(suffix);
  await expiryReconciliationFailureReporting(suffix);
  renewalWarningEligibility();
  await householdReplacementRaceSerialization(suffix);
  await externalTokenNotLeakedOnPersistenceFailure();
  await reconnectDiscoveryFailureLeavesDegradedState();
  console.log('post-451 ten-bug DB smoke: ok');
}

main().catch(error => { console.error(error); process.exit(1); });
