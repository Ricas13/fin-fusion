'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const accessIntegrity = require('../src/access/access-integrity');
const accessHolds = require('../src/entitlements/access-holds');
const serviceAdminControl = require('../src/entitlements/service-admin-control');

const tag = `access-integrity-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
const created = { customers: [], plans: [], servers: [] };

async function makeCustomer(label) {
  const row = await query(
    'INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id',
    [`Access integrity ${label} ${tag}`, `${label}-${tag}@example.invalid`]
  );
  created.customers.push(row.rows[0].id);
  return row.rows[0].id;
}

async function makeServer(label, serverClass) {
  const row = await query(`
    INSERT INTO jellyfin_servers(
      name,slug,server_class,media_server_type,base_url,public_url,api_key_encrypted,
      enabled,allow_new_users,trial_enabled,paid_enabled,priority,max_users,health_status
    )
    VALUES($1,$2,$3,'jellyfin',$4,$4,'jf1:smoke',TRUE,TRUE,TRUE,TRUE,1,100,'healthy')
    RETURNING id
  `, [
    `Access integrity ${label} ${tag}`,
    `access-integrity-${label}-${tag}`.slice(0, 180),
    serverClass,
    `https://${label}-${tag}.invalid`
  ]);
  created.servers.push(row.rows[0].id);
  return row.rows[0].id;
}

async function makePlan(label, { billingInterval = 'month', priceMinor = 999, serverClass = 'premium' } = {}) {
  const row = await query(`
    INSERT INTO plans(
      code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,
      capacity_limit,visible,active,streams,server_class,is_free_tier
    )
    VALUES($1,$2,'jellyfin','direct',$3,30,$4,'GBP',1000,TRUE,TRUE,1,$5,FALSE)
    RETURNING id
  `, [
    `access-integrity-${label}-${tag}`.slice(0, 180),
    `Access integrity ${label} ${tag}`,
    billingInterval,
    priceMinor,
    serverClass
  ]);
  created.plans.push(row.rows[0].id);
  return row.rows[0].id;
}

async function canonicalFreePlanId() {
  const row = await query(`
    SELECT id FROM plans
    WHERE is_free_tier=TRUE AND COALESCE(is_addon,FALSE)=FALSE
    ORDER BY created_at,id LIMIT 1
  `);
  assert.strictEqual(row.rowCount, 1, 'clean install must contain the canonical Free plan');
  return row.rows[0].id;
}

async function makeSubscription(customerId, planId, {
  status = 'active',
  source = 'manual',
  endSql = "NOW()+INTERVAL '30 days'"
} = {}) {
  const row = await query(`
    INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
    VALUES($1,$2,$3,$4,NOW()-INTERVAL '1 day',${endSql})
    RETURNING id
  `, [customerId, planId, status, source]);
  return row.rows[0].id;
}

async function makeAccount(customerId, serverId, lane, label) {
  const row = await query(`
    INSERT INTO jellyfin_accounts(
      customer_id,server_id,jellyfin_user_id,jellyfin_username,
      disabled,account_purpose,access_lane,is_primary
    )
    VALUES($1,$2,$3,$4,FALSE,'jellyfin',$5,TRUE)
    RETURNING id
  `, [
    customerId,
    serverId,
    `${label}-remote-${tag}`.slice(0, 180),
    `${label}_${tag}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 180),
    lane
  ]);
  return row.rows[0].id;
}

function kindsFor(findings, customerId) {
  return new Set(findings.filter(row => String(row.customerId || '') === String(customerId)).map(row => row.kind));
}

(async () => {
  const freePlanId = await canonicalFreePlanId();
  const freeServerId = await makeServer('free', 'free');
  const assignedFreeServerId = await makeServer('free-assigned', 'free');
  const premiumServerId = await makeServer('premium', 'premium');
  const assignedPremiumServerId = await makeServer('premium-assigned', 'premium');
  const trialPlanId = await makePlan('trial', { billingInterval: 'trial', priceMinor: 0 });
  const paidPlanId = await makePlan('paid', { billingInterval: 'month', priceMinor: 999 });

  try {
    const freeMissing = await makeCustomer('free-missing');
    await makeSubscription(freeMissing, freePlanId, { source: 'free_claim', endSql: "NOW()+INTERVAL '3000 days'" });

    const freeReady = await makeCustomer('free-ready');
    await makeSubscription(freeReady, freePlanId, { source: 'free_claim', endSql: "NOW()+INTERVAL '3000 days'" });
    await makeAccount(freeReady, freeServerId, 'free', 'free-ready');

    const freeWrongServer = await makeCustomer('free-wrong-server');
    const freeWrongSubscription = await makeSubscription(freeWrongServer, freePlanId, { source: 'free_claim', endSql: "NOW()+INTERVAL '3000 days'" });
    await query('UPDATE subscriptions SET media_server_id=$2 WHERE id=$1', [freeWrongSubscription, assignedFreeServerId]);
    await makeAccount(freeWrongServer, freeServerId, 'free', 'free-wrong-server');

    const freeAdminPinned = await makeCustomer('free-admin-pinned');
    const freeAdminPinnedSubscription = await makeSubscription(freeAdminPinned, freePlanId, { source: 'free_claim', endSql: "NOW()+INTERVAL '3000 days'" });
    await query('UPDATE subscriptions SET media_server_id=$2 WHERE id=$1', [freeAdminPinnedSubscription, assignedFreeServerId]);
    await makeAccount(freeAdminPinned, freeServerId, 'free', 'free-admin-pinned');
    await serviceAdminControl.pinServer(freeAdminPinned, freeServerId, {
      reason: 'access integrity admin pin smoke'
    });

    const migratedBlockedFreeMissing = await makeCustomer('free-migrated-blocked-missing');
    const migratedBlockedSubscription = await makeSubscription(
      migratedBlockedFreeMissing,
      freePlanId,
      { source: 'migration', endSql: "NOW()+INTERVAL '3000 days'" }
    );
    await accessHolds.addHold({
      customerId: migratedBlockedFreeMissing,
      type: 'inactivity_policy',
      sourceKey: `plan:${freePlanId}`,
      reason: 'Free Server inactivity restore pending successful reprovisioning',
      metadata: {
        subscriptionId: migratedBlockedSubscription,
        restoreReconcileFailed: true,
        error: 'synthetic restore failure'
      }
    });

    const claimedBlockedFreeMissing = await makeCustomer('free-claimed-blocked-missing');
    const claimedBlockedSubscription = await makeSubscription(
      claimedBlockedFreeMissing,
      freePlanId,
      { source: 'free_claim', endSql: "NOW()+INTERVAL '3000 days'" }
    );
    await accessHolds.addHold({
      customerId: claimedBlockedFreeMissing,
      type: 'inactivity_policy',
      sourceKey: `plan:${freePlanId}`,
      reason: 'access integrity claimed Free inactivity smoke',
      metadata: { subscriptionId: claimedBlockedSubscription }
    });

    const protectedFreeMissing = await makeCustomer('free-protected-missing');
    const protectedFreeSubscription = await makeSubscription(
      protectedFreeMissing,
      freePlanId,
      { source: 'free_claim', endSql: "NOW()+INTERVAL '3000 days'" }
    );
    await accessHolds.addHold({
      customerId: protectedFreeMissing,
      type: 'inactivity_policy',
      sourceKey: `plan:${freePlanId}`,
      reason: 'access integrity protected override smoke',
      metadata: { subscriptionId: protectedFreeSubscription }
    });
    await serviceAdminControl.setPresent(protectedFreeMissing, 'jellyfin', {
      reason: 'access integrity protected override smoke'
    });

    const permanentFreeMissing = await makeCustomer('free-permanent-missing');
    const permanentFreeSubscription = await makeSubscription(
      permanentFreeMissing,
      freePlanId,
      { source: 'free_claim', endSql: "NOW()+INTERVAL '3000 days'" }
    );
    await query(`
      INSERT INTO customer_entitlement_overrides(
        customer_id,subscription_id,permanent_access,reason,revoked_at
      )
      VALUES($1,$2,TRUE,'access integrity permanent override smoke',NULL)
      ON CONFLICT(customer_id) DO UPDATE SET
        subscription_id=EXCLUDED.subscription_id,
        permanent_access=TRUE,
        reason=EXCLUDED.reason,
        revoked_at=NULL,
        updated_at=NOW()
    `, [permanentFreeMissing, permanentFreeSubscription]);
    await accessHolds.addHold({
      customerId: permanentFreeMissing,
      type: 'inactivity_policy',
      sourceKey: `plan:${freePlanId}`,
      reason: 'access integrity permanent override smoke',
      metadata: { subscriptionId: permanentFreeSubscription }
    });

    const freeOrphan = await makeCustomer('free-orphan');
    await makeAccount(freeOrphan, freeServerId, 'free', 'free-orphan');

    const trialMissing = await makeCustomer('trial-missing');
    await makeSubscription(trialMissing, trialPlanId, { status: 'trialing', source: 'manual' });

    const trialWrongServer = await makeCustomer('trial-wrong-server');
    const trialWrongSubscription = await makeSubscription(trialWrongServer, trialPlanId, { status: 'trialing', source: 'manual' });
    await query('UPDATE subscriptions SET media_server_id=$2 WHERE id=$1', [trialWrongSubscription, assignedPremiumServerId]);
    await makeAccount(trialWrongServer, premiumServerId, 'primary', 'trial-wrong-server');

    const primaryOrphan = await makeCustomer('primary-orphan');
    await makeAccount(primaryOrphan, premiumServerId, 'primary', 'primary-orphan');

    const paidMissing = await makeCustomer('paid-missing');
    await makeSubscription(paidMissing, paidPlanId, { source: 'stripe' });
    // Subscription lifecycle hooks may eagerly create retry state. This fixture
    // specifically represents the unsafe case the watchdog is meant to detect:
    // a committed paid entitlement with neither a ready account nor durable
    // provisioning recovery state.
    await query('DELETE FROM customer_provisioning_state WHERE customer_id=$1', [paidMissing]);

    const paidWrongServer = await makeCustomer('paid-wrong-server');
    const paidWrongSubscription = await makeSubscription(paidWrongServer, paidPlanId, { source: 'stripe' });
    await query('UPDATE subscriptions SET media_server_id=$2 WHERE id=$1', [paidWrongSubscription, assignedPremiumServerId]);
    await makeAccount(paidWrongServer, premiumServerId, 'primary', 'paid-wrong-server');
    await query('DELETE FROM customer_provisioning_state WHERE customer_id=$1', [paidWrongServer]);

    const paidAdminPinned = await makeCustomer('paid-admin-pinned');
    const paidAdminPinnedSubscription = await makeSubscription(paidAdminPinned, paidPlanId, { source: 'stripe' });
    await query('UPDATE subscriptions SET media_server_id=$2 WHERE id=$1', [paidAdminPinnedSubscription, assignedPremiumServerId]);
    await makeAccount(paidAdminPinned, premiumServerId, 'primary', 'paid-admin-pinned');
    await serviceAdminControl.pinServer(paidAdminPinned, premiumServerId, {
      reason: 'access integrity paid admin pin smoke'
    });
    await query('DELETE FROM customer_provisioning_state WHERE customer_id=$1', [paidAdminPinned]);

    const findings = await accessIntegrity.scan({ limit: 500 });

    assert(kindsFor(findings, freeMissing).has('free_plan_without_ready_server'),
      'live Free plan without a ready Free account must be detected');
    assert(!kindsFor(findings, freeReady).has('free_plan_without_ready_server'),
      'ready Free plan+server must not be reported as inconsistent');
    assert(kindsFor(findings, freeWrongServer).has('free_plan_without_ready_server'),
      'a Free account on the wrong server must not satisfy the persisted assignment');
    assert(!kindsFor(findings, freeAdminPinned).has('free_plan_without_ready_server'),
      'an administrator-pinned Free account must override the stale persisted subscription assignment');
    assert(!kindsFor(findings, migratedBlockedFreeMissing).has('free_plan_without_ready_server'),
      'failed migrated Free restore must not be misclassified as a generic stranded entitlement');
    assert(kindsFor(findings, migratedBlockedFreeMissing).has('free_restore_reprovision_failed'),
      'failed migrated Free restore must remain visible as its own operator-attention finding');
    assert(!kindsFor(findings, claimedBlockedFreeMissing).has('free_plan_without_ready_server'),
      'Free claim under its exact inactivity hold must be treated as intentionally blocked, not stranded');
    assert(!kindsFor(findings, claimedBlockedFreeMissing).has('free_restore_reprovision_failed'),
      'ordinary inactivity removal must not be reported as a failed explicit restore');
    assert(kindsFor(findings, protectedFreeMissing).has('free_plan_without_ready_server'),
      'explicit administrator-present access must remain visible to the integrity scanner even when an automatic hold exists');
    assert(kindsFor(findings, permanentFreeMissing).has('free_plan_without_ready_server'),
      'Permanent Access must remain visible to the integrity scanner even when an automatic hold exists');
    assert(kindsFor(findings, freeOrphan).has('free_server_without_plan'),
      'Free account without a Free plan must be detected');
    assert(kindsFor(findings, trialMissing).has('unpaid_trial_without_ready_server'),
      'unpaid Jellyfin trial without a server must be detected');
    assert(kindsFor(findings, trialWrongServer).has('unpaid_trial_without_ready_server'),
      'an unpaid trial account on the wrong server must not satisfy the persisted assignment');
    assert(kindsFor(findings, primaryOrphan).has('primary_server_without_plan'),
      'primary account without a live primary entitlement must be detected');
    assert(kindsFor(findings, paidMissing).has('paid_plan_without_recovery_state'),
      'paid plan without a server must retain a durable provisioning recovery state');
    assert(kindsFor(findings, paidWrongServer).has('paid_plan_without_recovery_state'),
      'a paid account on the wrong server must not hide missing provisioning recovery for the assigned server');
    assert(!kindsFor(findings, paidAdminPinned).has('paid_plan_without_recovery_state'),
      'an administrator-pinned paid account must override the stale persisted subscription assignment');

    console.log('access integrity DB smoke: ok');
  } finally {
    for (const customerId of created.customers.reverse()) {
      await query('DELETE FROM customers WHERE id=$1', [customerId]).catch(() => {});
    }
    for (const planId of created.plans.reverse()) {
      await query('DELETE FROM plans WHERE id=$1', [planId]).catch(() => {});
    }
    for (const serverId of created.servers.reverse()) {
      await query('DELETE FROM jellyfin_servers WHERE id=$1', [serverId]).catch(() => {});
    }
  }
})().finally(() => getPool().end()).catch(error => {
  console.error('access integrity DB smoke failed:', error?.message || error);
  process.exit(1);
});
