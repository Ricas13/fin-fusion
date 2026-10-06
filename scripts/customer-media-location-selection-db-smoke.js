'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const choice = require('../src/jellyfin/customer-server-choice');
const userCapacity = require('../src/jellyfin/user-capacity');
const serviceAdminControl = require('../src/entitlements/service-admin-control');

(async () => {
  const suffix = crypto.randomBytes(5).toString('hex');
  const planIds = [];
  const customerIds = [];
  let serverId = null;
  let pinnedServerId = null;
  let laneServerId = null;
  const clients = [];

  try {
    const server = await query(`
      INSERT INTO jellyfin_servers(
        name,slug,server_class,media_server_type,base_url,public_url,location,
        api_key_encrypted,enabled,allow_new_users,paid_enabled,trial_enabled,
        priority,max_users,health_status,last_health_check,placement_mode
      ) VALUES($1,$2,'custom','jellyfin','https://shared.invalid','https://shared.invalid',
        'London','key',TRUE,TRUE,TRUE,TRUE,1,1,'healthy',NOW(),'active')
      RETURNING id
    `, [`Shared race ${suffix}`, `shared-race-${suffix}`]);
    serverId = server.rows[0].id;

    async function makePlan(label) {
      const row = (await query(`
        INSERT INTO plans(
          code,name,description,service_type,audience,billing_interval,duration_days,
          price_minor,currency,capacity_limit,inactivity_policy,is_addon,server_class,
          visible,active,streams
        ) VALUES($1,$1,'location race','jellyfin','direct','month',30,500,'GBP',1,
          '{"mediaCapacityManaged":true}'::jsonb,FALSE,'custom',TRUE,TRUE,1)
        RETURNING *
      `, [`location-race-${label}-${suffix}`])).rows[0];
      planIds.push(row.id);
      await query(`INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,100)`, [row.id, serverId]);
      return row;
    }

    async function makeCustomer(label) {
      const row = (await query(
        `INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`,
        [`Location race ${label} ${suffix}`, `location-race-${label}-${suffix}@example.invalid`]
      )).rows[0];
      customerIds.push(row.id);
      return row.id;
    }

    const [planA, planB] = await Promise.all([makePlan('a'), makePlan('b')]);
    const [customerA, customerB] = await Promise.all([makeCustomer('a'), makeCustomer('b')]);

    async function reserve(plan, customerId, marker) {
      const client = await getPool().connect();
      clients.push(client);
      try {
        await client.query('BEGIN');
        const db = (sql, params) => client.query(sql, params);
        const selected = await choice.selectServerForLocationLocked(plan, 'London', { db, requireSelection: true });
        await client.query(`
          INSERT INTO billing_checkout_intents(
            scope,customer_id,plan_id,provider,checkout_mode,nonce_hash,
            expires_at,capacity_hold_until,commercial_snapshot,media_server_id
          ) VALUES(
            'customer',$1,$2,'stripe','payment',$3,
            NOW()+INTERVAL '30 minutes',NOW()+INTERVAL '30 minutes',
            $4::jsonb,$5
          )
        `, [
          customerId,
          plan.id,
          crypto.createHash('sha256').update(marker).digest('hex'),
          JSON.stringify({
            kind: 'direct_plan',
            planId: plan.id,
            planCode: plan.code,
            planName: plan.name,
            provider: 'stripe',
            checkoutMode: 'payment',
            durationDays: 30,
            priceMinor: 500,
            currency: 'GBP',
            mediaLocation: 'London',
            mediaServerId: selected.id
          }),
          selected.id
        ]);
        await client.query('COMMIT');
        return { ok: true, serverId: selected.id };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        return { ok: false, code: error.code, message: error.message };
      } finally {
        client.release();
        clients.splice(clients.indexOf(client), 1);
      }
    }

    const results = await Promise.all([
      reserve(planA, customerA, `a-${suffix}`),
      reserve(planB, customerB, `b-${suffix}`)
    ]);

    assert.strictEqual(results.filter(result => result.ok).length, 1,
      'exactly one cross-plan checkout may reserve the final physical server place');
    assert.strictEqual(results.filter(result => !result.ok).length, 1,
      'the competing checkout must fail instead of overfilling the shared server');
    assert.match(results.find(result => !result.ok).message, /no longer available|eligible .* server/i);

    const occupancy = await require('../src/jellyfin/user-capacity').serverState(serverId);
    assert.strictEqual(occupancy.capacity_users, 1, 'physical capacity must record exactly one reserved customer');
    assert.strictEqual(occupancy.full, true, 'max-users=1 server must be full after the winning reservation');

    const pinnedServer = await query(`
      INSERT INTO jellyfin_servers(
        name,slug,server_class,media_server_type,base_url,public_url,location,
        api_key_encrypted,enabled,allow_new_users,paid_enabled,trial_enabled,
        priority,max_users,health_status,last_health_check,placement_mode
      ) VALUES($1,$2,'custom','jellyfin','https://pinned.invalid','https://pinned.invalid',
        'London','key',TRUE,TRUE,TRUE,TRUE,1,20,'healthy',NOW(),'active')
      RETURNING id
    `, [`Pinned capacity ${suffix}`, `pinned-capacity-${suffix}`]);
    pinnedServerId = pinnedServer.rows[0].id;

    const pinnedCustomer = await makeCustomer('pinned');
    const pinnedSubscription = await query(`
      INSERT INTO subscriptions(
        customer_id,plan_id,status,source,starts_at,current_period_end,media_server_id
      ) VALUES($1,$2,'active','manual',NOW(),NOW()+INTERVAL '30 days',$3)
      RETURNING id
    `, [pinnedCustomer, planA.id, serverId]);
    assert.strictEqual(pinnedSubscription.rowCount, 1);

    const oldBeforePin = await userCapacity.serverState(serverId);
    const targetBeforePin = await userCapacity.serverState(pinnedServerId);
    await serviceAdminControl.pinServer(pinnedCustomer, pinnedServerId, {
      reason: 'capacity assignment smoke'
    });
    const oldAfterPin = await userCapacity.serverState(serverId);
    const targetAfterPin = await userCapacity.serverState(pinnedServerId);
    assert.strictEqual(
      Number(oldAfterPin.capacity_users),
      Number(oldBeforePin.capacity_users) - 1,
      'admin pin must release the stale subscription-server capacity reservation'
    );
    assert.strictEqual(
      Number(targetAfterPin.capacity_users),
      Number(targetBeforePin.capacity_users) + 1,
      'admin pin must reserve physical capacity on the effective pinned server'
    );

    const extendedCustomer = await makeCustomer('prepaid-extension');
    await query(`
      INSERT INTO subscriptions(
        customer_id,plan_id,status,source,starts_at,current_period_end,
        service_extension_days,media_server_id,service_type_snapshot
      ) VALUES(
        $1,$2,'cancelled','manual',NOW()-INTERVAL '31 days',NOW()-INTERVAL '1 day',
        30,$3,'jellyfin'
      )
    `, [extendedCustomer, planA.id, pinnedServerId]);
    const targetWithExtendedAccess = await userCapacity.serverState(pinnedServerId);
    assert.strictEqual(
      Number(targetWithExtendedAccess.capacity_users),
      Number(targetAfterPin.capacity_users) + 1,
      'prepaid extension access must keep the assigned physical server slot reserved after the provider base term ends even when its remote account is temporarily missing'
    );

    const laneServer = await query(`
      INSERT INTO jellyfin_servers(
        name,slug,server_class,media_server_type,base_url,public_url,location,
        api_key_encrypted,enabled,allow_new_users,paid_enabled,trial_enabled,
        priority,max_users,health_status,last_health_check,placement_mode
      ) VALUES($1,$2,'custom','jellyfin','https://lanes.invalid','https://lanes.invalid',
        'London','key',TRUE,TRUE,TRUE,TRUE,1,10,'healthy',NOW(),'active')
      RETURNING id
    `, [`Lane capacity ${suffix}`, `lane-capacity-${suffix}`]);
    laneServerId = laneServer.rows[0].id;
    const laneCustomer = await makeCustomer('parallel-lanes');
    await query(`
      INSERT INTO jellyfin_accounts(
        customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,is_primary,access_lane
      ) VALUES
        ($1,$2,$3,$4,FALSE,FALSE,'primary'),
        ($1,$2,$5,$6,FALSE,FALSE,'free')
    `, [
      laneCustomer, laneServerId,
      `lane-primary-${suffix}`, `lane-primary-${suffix}`,
      `lane-free-${suffix}`, `lane-free-${suffix}`
    ]);
    await query(`
      INSERT INTO subscriptions(
        customer_id,plan_id,status,source,starts_at,current_period_end,media_server_id
      ) VALUES($1,$2,'active','manual',NOW(),NOW()+INTERVAL '30 days',$3)
    `, [laneCustomer, planA.id, laneServerId]);
    const laneOccupancy = await userCapacity.serverState(laneServerId);
    assert.strictEqual(
      Number(laneOccupancy.capacity_users),
      2,
      'parallel paid-primary and Free remote accounts on one physical server must consume two slots while the primary subscription deduplicates with its account'
    );

    console.log('customer media location cross-plan concurrency DB smoke: ok');
  } finally {
    for (const client of clients.splice(0)) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    if (customerIds.length) {
      await query('DELETE FROM billing_checkout_intents WHERE customer_id=ANY($1::uuid[])', [customerIds]).catch(() => {});
      await query('DELETE FROM subscriptions WHERE customer_id=ANY($1::uuid[])', [customerIds]).catch(() => {});
      await query('DELETE FROM customers WHERE id=ANY($1::uuid[])', [customerIds]).catch(() => {});
    }
    if (planIds.length) {
      await query('DELETE FROM plan_server_eligibility WHERE plan_id=ANY($1::uuid[])', [planIds]).catch(() => {});
      await query('DELETE FROM plans WHERE id=ANY($1::uuid[])', [planIds]).catch(() => {});
    }
    if (laneServerId) await query('DELETE FROM jellyfin_servers WHERE id=$1', [laneServerId]).catch(() => {});
    if (pinnedServerId) await query('DELETE FROM jellyfin_servers WHERE id=$1', [pinnedServerId]).catch(() => {});
    if (serverId) await query('DELETE FROM jellyfin_servers WHERE id=$1', [serverId]).catch(() => {});
    await getPool().end();
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
