'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { getPool } = require('../src/db');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = getPool();
  const client = await pool.connect();
  const suffix = crypto.randomBytes(5).toString('hex');
  try {
    await client.query('BEGIN');

    const oldTrigger = await client.query(`
      SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.subscriptions'::regclass
        AND tgname='single_live_customer_recurring_subscription_trigger'
        AND NOT tgisinternal
    `);
    assert.strictEqual(oldTrigger.rowCount, 0, 'superseded recurring trigger must be removed');

    const indexes = await client.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname='public'
        AND indexname IN (
          'active_playback_sessions_jellyfin_account_idx',
          'stremio_managed_accounts_jellyfin_account_idx'
        )
    `);
    assert.strictEqual(indexes.rowCount, 2, 'both hot-path Jellyfin-account indexes must exist');

    const customer = (await client.query(
      `INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`,
      [`Post Audit ${suffix}`, `post-audit-${suffix}@example.invalid`]
    )).rows[0];
    const plan = (await client.query(
      `INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,active,visible,server_class,streams,service_type)
       VALUES($1,$2,'direct','month',30,799,'GBP',TRUE,TRUE,'premium',2,'jellyfin') RETURNING id`,
      [`post-audit-${suffix}`, `Post Audit ${suffix}`]
    )).rows[0];
    const firstSub = (await client.query(
      `INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id)
       VALUES($1,$2,'active','stripe','subscription',NOW(),NOW()+INTERVAL '30 days',$3) RETURNING id`,
      [customer.id, plan.id, `sub_live_${suffix}`]
    )).rows[0];
    const lostSub = (await client.query(
      `INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id)
       VALUES($1,$2,'cancelled','stripe','subscription',NOW(),NOW(),$3) RETURNING id`,
      [customer.id, plan.id, `sub_lost_${suffix}`]
    )).rows[0];

    await client.query(
      `INSERT INTO payment_incidents(provider,provider_case_id,incident_type,incident_status,customer_id,provider_subscription_id,metadata)
       VALUES('stripe',$1,'chargeback','lost',$2,$3,$4::jsonb)`,
      [`dp_lost_${suffix}`, customer.id, `sub_lost_${suffix}`, JSON.stringify({ lost: true })]
    );
    await client.query(
      `UPDATE subscriptions SET status='active',current_period_end=NOW()+INTERVAL '30 days' WHERE id=$1`,
      [lostSub.id]
    );
    const normalized = (await client.query(
      `SELECT status,refund_terminated_at,cancel_at_period_end FROM subscriptions WHERE id=$1`,
      [lostSub.id]
    )).rows[0];
    assert.strictEqual(normalized.status, 'cancelled', 'confirmed money loss must normalize before recurring-overlap validation');
    assert(normalized.refund_terminated_at, 'confirmed money loss must remain durably terminal');
    assert.strictEqual(normalized.cancel_at_period_end, true);
    assert(firstSub.id, 'control recurring subscription must remain present');

    await client.query(
      `INSERT INTO customer_policy_overrides(customer_id,streams,allow_downloads) VALUES($1,5,TRUE)`,
      [customer.id]
    );
    let lane = (await client.query(
      `SELECT streams,allow_downloads FROM customer_lane_policy_overrides WHERE customer_id=$1 AND access_lane='primary'`,
      [customer.id]
    )).rows[0];
    assert(lane, 'legacy policy writes must converge into canonical primary-lane policy');
    assert.strictEqual(Number(lane.streams), 5);
    assert.strictEqual(lane.allow_downloads, true);

    await client.query(
      `UPDATE customer_lane_policy_overrides SET streams=3,allow_downloads=FALSE WHERE customer_id=$1 AND access_lane='primary'`,
      [customer.id]
    );
    let legacy = (await client.query(
      `SELECT streams,allow_downloads FROM customer_policy_overrides WHERE customer_id=$1`,
      [customer.id]
    )).rows[0];
    assert.strictEqual(Number(legacy.streams), 3, 'canonical primary-lane writes must keep compatibility state current');
    assert.strictEqual(legacy.allow_downloads, false);

    await client.query(
      `DELETE FROM customer_policy_overrides WHERE customer_id=$1`,
      [customer.id]
    );
    lane = (await client.query(
      `SELECT 1 FROM customer_lane_policy_overrides WHERE customer_id=$1 AND access_lane='primary'`,
      [customer.id]
    ));
    assert.strictEqual(lane.rowCount, 0, 'legacy reset must clear canonical primary-lane override');

    await client.query(
      `INSERT INTO customer_service_admin_control(customer_id,service,mode,reason)
       VALUES($1,'jellyfin','admin_removed','audit smoke')`,
      [customer.id]
    );
    let legacyAdmin = (await client.query(
      `SELECT mode,reason FROM customer_jellyfin_admin_control WHERE customer_id=$1`,
      [customer.id]
    )).rows[0];
    assert(legacyAdmin, 'canonical Jellyfin admin authority must mirror to legacy bulk-list compatibility state');
    assert.strictEqual(legacyAdmin.mode, 'removed');

    await client.query(
      `DELETE FROM customer_service_admin_control WHERE customer_id=$1 AND service='jellyfin'`,
      [customer.id]
    );
    legacyAdmin = await client.query(
      `SELECT 1 FROM customer_jellyfin_admin_control WHERE customer_id=$1`,
      [customer.id]
    );
    assert.strictEqual(legacyAdmin.rowCount, 0, 'clearing canonical Jellyfin admin authority must clear legacy compatibility state');

    await client.query('ROLLBACK');
    console.log('post-audit schema hardening database smoke: ok');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
