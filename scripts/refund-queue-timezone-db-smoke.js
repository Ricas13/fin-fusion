'use strict';
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('refund queue timezone DB smoke')) process.exit(0);
const assert = require('assert');
const crypto = require('crypto');
const { transaction, getPool } = require('../src/db');

async function main() {
  for (const zone of ['UTC', 'Europe/London', 'America/New_York']) {
    await transaction(async client => {
      await client.query("SELECT set_config('TimeZone',$1,true)", [zone]);
      const suffix = crypto.randomBytes(8).toString('hex');
      const customer = (await client.query(`INSERT INTO customers(display_name,email) VALUES('Refund timezone',$1) RETURNING id`, [`refund-zone-${suffix}@example.invalid`])).rows[0];
      const plan = (await client.query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,active,visible)
        VALUES($1,'Refund timezone','jellyfin','direct','month',30,600,'GBP',TRUE,TRUE) RETURNING id`, [`refund-zone-${suffix}`])).rows[0];
      const year = new Date().getUTCFullYear() + 2;
      const boundary = `${year}-10-15T12:00:00Z`;
      const rows = [];
      for (let i = 0; i < 3; i++) {
        rows.push((await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,service_type_snapshot,billing_interval_snapshot,duration_days_snapshot)
          VALUES($1,$2,'active','stripe',$3,NOW(),$4,'jellyfin','month',30) RETURNING *`,
        [customer.id, plan.id, `pi_zone_${suffix}_${i}`, boundary])).rows[0]);
      }
      const beforeDuration = new Date(rows[2].current_period_end) - new Date(rows[2].starts_at);
      await client.query(`INSERT INTO payment_incidents(provider,provider_event_id,provider_case_id,incident_type,incident_status,scope,customer_id,provider_subscription_id,amount_minor,currency,access_action,metadata)
        VALUES('stripe',$1,$2,'refund','recorded','direct',$3,$4,600,'GBP','preserve','{"originalAmountMinor":600,"fullRefund":true}'::jsonb)`,
      [`evt_zone_${suffix}`, `ch_zone_${suffix}`, customer.id, rows[1].provider_subscription_id]);
      const after = (await client.query('SELECT * FROM subscriptions WHERE id=$1', [rows[2].id])).rows[0];
      assert.equal(new Date(after.starts_at).getTime(), new Date(rows[0].current_period_end).getTime(), `${zone}: refund must close the exact queue gap across DST`);
      assert.equal(new Date(after.current_period_end) - new Date(after.starts_at), beforeDuration, `${zone}: retain every millisecond of the later paid purchase`);
      await client.query('DELETE FROM payment_incidents WHERE customer_id=$1', [customer.id]);
      await client.query('DELETE FROM subscriptions WHERE customer_id=$1', [customer.id]);
      await client.query('DELETE FROM customers WHERE id=$1', [customer.id]);
      await client.query('DELETE FROM plans WHERE id=$1', [plan.id]);
    });
  }
  console.log('refund queue timezone DB smoke: ok (UTC, Europe/London, America/New_York)');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => getPool().end());
