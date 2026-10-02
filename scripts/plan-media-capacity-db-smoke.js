'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const capacity = require('../src/entitlements/plan-capacity');

(async () => {
  const suffix = crypto.randomBytes(5).toString('hex');
  let serverId = null;
  const planIds = [];
  const customerIds = [];
  try {
    const server = await query(`
      INSERT INTO jellyfin_servers(
        name,slug,server_class,media_server_type,base_url,api_key_encrypted,
        enabled,allow_new_users,paid_enabled,trial_enabled,priority,max_users,
        health_status,last_health_check,placement_mode
      ) VALUES($1,$2,'custom','jellyfin','https://capacity.invalid','key',
        TRUE,TRUE,TRUE,TRUE,1,200,'healthy',NOW(),'active')
      RETURNING id
    `, [`Capacity ${suffix}`, `capacity-${suffix}`]);
    serverId = server.rows[0].id;

    async function makePlan(code, mediaUserLimit) {
      const row = (await query(`
        INSERT INTO plans(
          code,name,description,service_type,audience,billing_interval,duration_days,
          price_minor,currency,capacity_limit,inactivity_policy,is_addon,server_class,
          visible,active,streams
        ) VALUES($1,$2,'capacity smoke','jellyfin','direct','month',30,500,'GBP',$3,$4::jsonb,FALSE,'custom',TRUE,TRUE,1)
        RETURNING id
      `, [code, code, mediaUserLimit, JSON.stringify({ mediaCapacityManaged: true })])).rows[0];
      planIds.push(row.id);
      await query(`INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,100)`, [row.id, serverId]);
      return row.id;
    }

    const limitedPlan = await makePlan(`capacity-limited-${suffix}`, 50);
    let state = await capacity.usage(limitedPlan);
    assert.strictEqual(state.model, 'fleet_users');
    assert.strictEqual(state.physicalUserLimit, 200, 'physical fleet ceiling must come from server max_users');
    assert.strictEqual(state.planUserLimit, 50, 'plan ceiling must be independent from physical capacity');
    assert.strictEqual(state.limit, 50, 'effective capacity must use the lower plan ceiling');
    assert.strictEqual(state.remaining, 50);

    await query(`UPDATE plans SET capacity_limit=NULL WHERE id=$1`, [limitedPlan]);
    state = await capacity.usage(limitedPlan);
    assert.strictEqual(state.planUserLimit, null, 'NULL plan ceiling means use the eligible physical fleet');
    assert.strictEqual(state.limit, 200);
    assert.strictEqual(state.remaining, 200);

    await query(`UPDATE plans SET capacity_limit=300 WHERE id=$1`, [limitedPlan]);
    state = await capacity.usage(limitedPlan);
    assert.strictEqual(state.planUserLimit, 300);
    assert.strictEqual(state.limit, 200, 'plan configuration must never manufacture capacity beyond the servers');
    assert.strictEqual(state.remaining, 200);

    await query(`UPDATE plans SET capacity_limit=50 WHERE id=$1`, [limitedPlan]);

    const planCustomer = (await query(
      `INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`,
      [`Plan customer ${suffix}`, `plan-${suffix}@example.invalid`]
    )).rows[0];
    customerIds.push(planCustomer.id);
    await query(`
      INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
      VALUES($1,$2,'active','manual',NOW()-INTERVAL '1 day',NOW()+INTERVAL '30 days')
    `, [planCustomer.id, limitedPlan]);
    await query(`
      INSERT INTO jellyfin_accounts(
        customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,
        account_purpose,access_lane,is_primary
      ) VALUES($1,$2,$3,$4,FALSE,'jellyfin','paid',TRUE)
    `, [planCustomer.id, serverId, `remote-plan-${suffix}`, `plan_${suffix}`]);

    const otherPlan = await makePlan(`capacity-other-${suffix}`, null);
    const otherCustomer = (await query(
      `INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`,
      [`Other customer ${suffix}`, `other-${suffix}@example.invalid`]
    )).rows[0];
    customerIds.push(otherCustomer.id);
    await query(`
      INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
      VALUES($1,$2,'active','manual',NOW()-INTERVAL '1 day',NOW()+INTERVAL '30 days')
    `, [otherCustomer.id, otherPlan]);
    await query(`
      INSERT INTO jellyfin_accounts(
        customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,
        account_purpose,access_lane,is_primary
      ) VALUES($1,$2,$3,$4,FALSE,'jellyfin','paid',TRUE)
    `, [otherCustomer.id, serverId, `remote-other-${suffix}`, `other_${suffix}`]);

    state = await capacity.usage(limitedPlan);
    assert.strictEqual(state.planUsed, 1, 'plan usage must count only customers of this product');
    assert.strictEqual(state.managedUsers, 2, 'physical usage must count all managed customers on eligible servers');
    assert.strictEqual(state.planRemaining, 49);
    assert.strictEqual(state.physicalRemaining, 198);
    assert.strictEqual(state.remaining, 49, 'effective availability must be the lower of plan and physical remaining capacity');

    await query(`UPDATE plans SET capacity_limit=500 WHERE id=$1`, [limitedPlan]);
    state = await capacity.usage(limitedPlan);
    assert.strictEqual(state.remaining, 198, 'when plan ceiling exceeds infrastructure, physical remaining capacity must win');

    console.log('plan-owned media capacity DB smoke: ok');
  } finally {
    if (customerIds.length) await query('DELETE FROM customers WHERE id=ANY($1::uuid[])', [customerIds]).catch(() => {});
    if (planIds.length) await query('DELETE FROM plans WHERE id=ANY($1::uuid[])', [planIds]).catch(() => {});
    if (serverId) await query('DELETE FROM jellyfin_servers WHERE id=$1', [serverId]).catch(() => {});
    await getPool().end();
  }
})().catch(async error => {
  console.error(error);
  try { await getPool().end(); } catch (_) {}
  process.exit(1);
});
