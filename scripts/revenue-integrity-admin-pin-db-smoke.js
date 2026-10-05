'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const accessHolds = require('../src/entitlements/access-holds');
const serviceAdminControl = require('../src/entitlements/service-admin-control');
const {
  JELLYFIN_ADMIN_AUTHORITY_VIOLATIONS_SQL
} = require('../src/automation/revenue-integrity');

const tag = `revenue-pin-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
let customerId = null;
let serverId = null;

async function authorityViolations() {
  const result = await query(JELLYFIN_ADMIN_AUTHORITY_VIOLATIONS_SQL);
  return result.rows.filter(row => String(row.customer_id) === String(customerId));
}

(async () => {
  const freePlan = await query(`
    SELECT id
    FROM plans
    WHERE is_free_tier=TRUE
      AND COALESCE(is_addon,FALSE)=FALSE
      AND COALESCE(service_type,'jellyfin') IN('jellyfin','bundle')
    ORDER BY created_at,id
    LIMIT 1
  `);
  assert.strictEqual(freePlan.rowCount, 1, 'clean install must contain a canonical Free Jellyfin plan');

  const customer = await query(
    'INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id',
    [`Revenue pin smoke ${tag}`, `${tag}@example.invalid`]
  );
  customerId = customer.rows[0].id;

  const server = await query(`
    INSERT INTO jellyfin_servers(
      name,slug,server_class,media_server_type,base_url,public_url,api_key_encrypted,
      enabled,allow_new_users,trial_enabled,paid_enabled,priority,max_users,health_status
    )
    VALUES($1,$2,'free','jellyfin',$3,$3,'jf1:smoke',TRUE,TRUE,TRUE,TRUE,1,100,'healthy')
    RETURNING id
  `, [
    `Revenue pin smoke ${tag}`,
    `revenue-pin-${tag}`.slice(0, 180),
    `https://${tag}.invalid`
  ]);
  serverId = server.rows[0].id;

  const subscription = await query(`
    INSERT INTO subscriptions(
      customer_id,plan_id,status,source,starts_at,current_period_end
    )
    VALUES($1,$2,'active','free_claim',NOW()-INTERVAL '1 day',NOW()+INTERVAL '3000 days')
    RETURNING id
  `, [customerId, freePlan.rows[0].id]);

  await serviceAdminControl.pinServer(customerId, serverId, {
    reason: 'placement-only revenue integrity smoke'
  });
  await query(`
    UPDATE customer_service_admin_control
    SET updated_at=NOW()-INTERVAL '3 minutes'
    WHERE customer_id=$1 AND service='jellyfin'
  `, [customerId]);

  await accessHolds.addHold({
    customerId,
    type: 'inactivity_policy',
    sourceKey: `plan:${freePlan.rows[0].id}`,
    reason: 'placement-only pin must not override Free inactivity',
    metadata: { subscriptionId: subscription.rows[0].id }
  });

  let rows = await authorityViolations();
  assert.strictEqual(rows.length, 0,
    'a placement-only server pin must not page as a missing account while canonical access is blocked');

  await accessHolds.releaseHold({
    customerId,
    type: 'inactivity_policy',
    sourceKey: `plan:${freePlan.rows[0].id}`,
    resolutionReason: 'smoke restore'
  });

  rows = await authorityViolations();
  assert.strictEqual(rows.length, 1,
    'an unblocked live entitlement with a server pin and no target account must still be detected');
  assert.strictEqual(rows[0].violation, 'pinned_account_missing_on_target_server');
  assert.strictEqual(String(rows[0].server_id), String(serverId));

  await query(`
    INSERT INTO jellyfin_accounts(
      customer_id,server_id,jellyfin_user_id,jellyfin_username,
      disabled,account_purpose,access_lane,is_primary
    )
    VALUES($1,$2,$3,$4,FALSE,'jellyfin','free',TRUE)
  `, [
    customerId,
    serverId,
    `remote-${tag}`,
    `user_${tag}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 180)
  ]);

  rows = await authorityViolations();
  assert.strictEqual(rows.length, 0,
    'a live pinned entitlement must stop alerting once the active account exists on the pinned server');

  const stremioPlan = await query(`
    SELECT id
    FROM plans
    WHERE COALESCE(service_type,'jellyfin')='stremio'
      AND COALESCE(is_addon,FALSE)=FALSE
      AND active=TRUE
    ORDER BY created_at,id
    LIMIT 1
  `);
  if (stremioPlan.rowCount) {
    await query('DELETE FROM jellyfin_accounts WHERE customer_id=$1', [customerId]);
    await query('UPDATE subscriptions SET superseded_by=NULL,status=\'cancelled\',current_period_end=NOW()-INTERVAL \'1 minute\' WHERE customer_id=$1', [customerId]);
    await query(`
      INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,service_type_snapshot)
      VALUES($1,$2,'active','manual',NOW()-INTERVAL '1 day',NOW()+INTERVAL '30 days','stremio')
    `, [customerId, stremioPlan.rows[0].id]);
    rows = await authorityViolations();
    assert.strictEqual(rows.length, 0,
      'a Stremio-only entitlement must never authorize a Jellyfin server-pin account requirement');
  }

  console.log('revenue integrity placement-only admin pin DB smoke: ok');
})().finally(async () => {
  if (customerId) await query('DELETE FROM customers WHERE id=$1', [customerId]).catch(() => {});
  if (serverId) await query('DELETE FROM jellyfin_servers WHERE id=$1', [serverId]).catch(() => {});
  await getPool().end();
}).catch(error => {
  console.error('revenue integrity placement-only admin pin DB smoke failed:', error?.stack || error);
  process.exit(1);
});
