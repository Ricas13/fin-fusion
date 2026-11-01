'use strict';

// An administrator can add a plan to a customer even when the plan (or its servers) is full, so the
// customer stays on a managed plan that automation monitors instead of being forced or left out.
// Customers and automation still cannot: the default is refusal, and the override is audited.

require('dotenv').config();
const assert = require('assert');
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('admin plan capacity override DB smoke')) process.exit(0);

const { query, getPool } = require('../src/db');
const manual = require('../src/entitlements/admin-manual-entitlement-service');
const lifecycle = require('../src/access/admin-customer-lifecycle-service');
const { unique, fixtureCustomer, fixturePlan, fixtureSubscription } = require('./test-fixture');

const created = { customers: [], plans: [], servers: [] };

async function newCustomer(label) {
  const c = await fixtureCustomer({ query }, { displayName: label, email: `${unique(label)}@example.invalid` });
  created.customers.push(c.id);
  return c;
}
async function newPlan(label, extra = {}) {
  const p = await fixturePlan({ query }, { code: unique(label), name: label, serviceType: 'jellyfin', audience: 'direct', billingInterval: 'month', durationDays: 30, priceMinor: 1000, currency: 'GBP', streams: 1, serverClass: 'premium', capacityLimit: 1, ...extra });
  created.plans.push(p.id);
  return p;
}
const grantInput = (planId, over = false) => manual.normalizedGrantInput({ planId, method: 'other', currency: 'GBP', amount: '0.00', confirm: '1', startDate: new Date().toISOString().slice(0, 10), endDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), ...(over ? { allowOverCapacity: '1' } : {}) });

async function main() {
  // --- Manual grant onto a full plan.
  // A plan restricted by explicit server eligibility to one server whose user limit is reached, so it
  // is full regardless of any other servers other tests may have left behind.
  const fullPlan = await newPlan('Full plan');
  const tightServer = (await query(`INSERT INTO jellyfin_servers(name,slug,server_class,base_url,public_url,location,api_key_encrypted,enabled,allow_new_users,paid_enabled,trial_enabled,priority,max_users,health_status,last_health_check)
    VALUES($1,$1,'premium','https://tight.example.invalid','https://tight.example.invalid','Tight','key',TRUE,TRUE,TRUE,TRUE,10,1,'healthy',NOW()) RETURNING id`, [unique('tight-server')])).rows[0].id;
  created.servers.push(tightServer);
  await query('INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,100)', [fullPlan.id, tightServer]);
  const holder = await newCustomer('Holder');
  await query(`INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,account_purpose) VALUES($1,$2,$3,$4,FALSE,'jellyfin')`, [holder.id, tightServer, unique('jfu'), unique('holder')]);
  const target = await newCustomer('Target');
  assert.strictEqual(grantInput(fullPlan.id).allowOverCapacity, false, 'the override is off unless the administrator ticks it');
  await assert.rejects(() => manual.createManualGrant(target.id, null, grantInput(fullPlan.id)), /sold out/i, 'a full plan is refused by default');
  assert.strictEqual((await query('SELECT COUNT(*)::int n FROM subscriptions WHERE customer_id=$1', [target.id])).rows[0].n, 0, 'a refused grant creates nothing');

  const granted = await manual.createManualGrant(target.id, null, grantInput(fullPlan.id, true));
  assert.strictEqual(granted.capacityOverride, true, 'the override is reported');
  const sub = (await query(`SELECT id,status,source FROM subscriptions WHERE customer_id=$1 AND plan_id=$2`, [target.id, fullPlan.id])).rows[0];
  assert(sub && sub.status === 'active', 'the customer holds the plan, so automation manages it');
  const audit = (await query(`SELECT metadata FROM audit_log WHERE action='admin.customer.manual_grant' AND (entity_id=$1 OR entity_id=$2) AND metadata->>'planCode'=$3`, [String(target.id), String(sub.id), fullPlan.code])).rows[0];
  assert(audit, 'the grant is audited');
  assert.strictEqual(audit.metadata.capacityOverride, true, 'and the audit records that capacity was overridden');

  // An override on a plan that still has room is not reported as an override.
  const roomy = await newPlan('Roomy plan', { capacityLimit: 50, serverClass: 'custom' });
  const server = (await query(`INSERT INTO jellyfin_servers(name,slug,server_class,base_url,public_url,location,api_key_encrypted,enabled,allow_new_users,paid_enabled,trial_enabled,priority,max_users,health_status,last_health_check)
    VALUES($1,$1,'custom','https://room.example.invalid','https://room.example.invalid','Room','key',TRUE,TRUE,TRUE,TRUE,10,100,'healthy',NOW()) RETURNING id`, [unique('room-server')])).rows[0].id;
  created.servers.push(server);
  await query('INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,100)', [roomy.id, server]);
  const another = await newCustomer('Another');
  const normal = await manual.createManualGrant(another.id, null, grantInput(roomy.id, true));
  assert.strictEqual(normal.capacityOverride, false, 'ticking the box on a plan with room is an ordinary grant');

  // --- The reported case: a Free-class pool whose only server is full (server user limit reached).
  const freePlan = (await query(`SELECT * FROM plans WHERE is_free_tier=TRUE LIMIT 1`)).rows[0];
  assert(freePlan, 'the canonical Free plan must exist');
  const freeServer = (await query(`INSERT INTO jellyfin_servers(name,slug,server_class,base_url,public_url,location,api_key_encrypted,enabled,allow_new_users,paid_enabled,trial_enabled,priority,max_users,health_status,last_health_check)
    VALUES($1,$1,'free','https://free.example.invalid','https://free.example.invalid','Free','key',TRUE,TRUE,TRUE,TRUE,10,1,'healthy',NOW()) RETURNING id`, [unique('free-server')])).rows[0].id;
  created.servers.push(freeServer);
  await query('INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,100)', [freePlan.id, freeServer]);
  const occupant = await newCustomer('Occupant');
  await query(`INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,account_purpose) VALUES($1,$2,$3,$4,FALSE,'jellyfin')`, [occupant.id, freeServer, unique('jfu'), unique('occ')]);
  const freeTarget = await newCustomer('Free target');
  await assert.rejects(() => manual.createManualGrant(freeTarget.id, null, grantInput(freePlan.id)), /sold out|No eligible/i, 'a full Free pool refuses the grant by default');
  const freeGranted = await manual.createManualGrant(freeTarget.id, null, grantInput(freePlan.id, true));
  assert.strictEqual(freeGranted.capacityOverride, true, 'the administrator can grant onto a full Free pool');
  assert.strictEqual((await query(`SELECT COUNT(*)::int n FROM subscriptions WHERE customer_id=$1 AND plan_id=$2 AND status='active'`, [freeTarget.id, freePlan.id])).rows[0].n, 1, 'the customer holds the managed plan');
  assert.strictEqual((await query(`SELECT COUNT(*)::int n FROM jellyfin_accounts WHERE customer_id=$1`, [freeTarget.id])).rows[0].n, 0, 'and has no account yet, to be placed with Add to server (which overrides capacity)');

  // --- Change plan onto a full plan.
  const currentPlan = await newPlan('Current plan', { capacityLimit: 50 });
  const mover = await newCustomer('Mover');
  const moverSub = await fixtureSubscription({ query }, { customerId: mover.id, planId: currentPlan.id, source: 'admin_grant', billingMode: 'manual' });
  await query(`UPDATE subscriptions SET media_server_id=$1,media_location_snapshot='Room' WHERE id=$2`, [server, moverSub.id]);
  await assert.rejects(() => lifecycle.changePlan({ customerId: mover.id, subscriptionId: moverSub.id, targetPlanId: fullPlan.id }), /sold out/i, 'moving onto a full plan is refused by default');
  assert.strictEqual(String((await query('SELECT plan_id FROM subscriptions WHERE id=$1', [moverSub.id])).rows[0].plan_id), String(currentPlan.id), 'a refused change leaves the plan alone');
  const moved = await lifecycle.changePlan({ customerId: mover.id, subscriptionId: moverSub.id, targetPlanId: fullPlan.id, allowOverCapacity: true });
  assert(/capacity override/i.test(moved.message) && /no server for it yet/i.test(moved.message), 'the result says it was an override with placement still to do');
  const movedRow = (await query('SELECT media_server_id,media_location_snapshot FROM subscriptions WHERE id=$1', [moverSub.id])).rows[0];
  assert.strictEqual(movedRow.media_server_id, null, 'the previous plan\'s server assignment is cleared, not silently kept');
  assert.strictEqual(movedRow.media_location_snapshot, null, 'and so is its location');
  assert.strictEqual(String((await query('SELECT plan_id FROM subscriptions WHERE id=$1', [moverSub.id])).rows[0].plan_id), String(fullPlan.id), 'the override moves the customer onto the full plan');
  const changeAudit = (await query(`SELECT metadata FROM audit_log WHERE action='admin.customer.plan_change' AND (entity_id=$1 OR entity_id=$2)`, [String(mover.id), String(moverSub.id)])).rows[0];
  assert.strictEqual(changeAudit.metadata.capacityOverride, true, 'the plan change audit records the override');
  assert.strictEqual((await query(`SELECT COUNT(*)::int n FROM audit_log WHERE action='admin.customer.plan_change.capacity_override' AND entity_id=$1`, [String(mover.id)])).rows[0].n, 1, 'and the override has its own audit row written in the same transaction');

  // The override audit is atomic with the change: if it cannot be written the plan is not changed.
  const atomicMover = await newCustomer('Atomic mover');
  const atomicSub = await fixtureSubscription({ query }, { customerId: atomicMover.id, planId: currentPlan.id, source: 'admin_grant', billingMode: 'manual' });
  await query(`CREATE OR REPLACE FUNCTION zz_block_override_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='admin.customer.plan_change.capacity_override' THEN RAISE EXCEPTION 'audit blocked for test'; END IF; RETURN NEW; END $$`);
  await query(`CREATE TRIGGER zz_block_override_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION zz_block_override_audit()`);
  try {
    await assert.rejects(() => lifecycle.changePlan({ customerId: atomicMover.id, subscriptionId: atomicSub.id, targetPlanId: fullPlan.id, allowOverCapacity: true }), /audit blocked/);
    assert.strictEqual(String((await query('SELECT plan_id FROM subscriptions WHERE id=$1', [atomicSub.id])).rows[0].plan_id), String(currentPlan.id), 'a change whose override audit failed is not applied');
  } finally {
    await query('DROP TRIGGER IF EXISTS zz_block_override_audit ON audit_log');
    await query('DROP FUNCTION IF EXISTS zz_block_override_audit()');
  }

  // A pool with NO eligible server at all is a configuration problem, not a full pool: the override does not apply.
  const noHostPlan = await newPlan('No host plan', { capacityLimit: 50, serverClass: 'custom' });
  const lonely = await newCustomer('Lonely');
  const emptyServer = (await query(`INSERT INTO jellyfin_servers(name,slug,server_class,base_url,public_url,location,api_key_encrypted,enabled,allow_new_users,paid_enabled,trial_enabled,priority,max_users,health_status,last_health_check) VALUES($1,$1,'custom','https://off.example.invalid','https://off.example.invalid','Off','key',FALSE,TRUE,TRUE,TRUE,10,10,'healthy',NOW()) RETURNING id`, [unique('off-server')])).rows[0].id;
  created.servers.push(emptyServer);
  await query('INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,100)', [noHostPlan.id, emptyServer]);
  await assert.rejects(() => manual.createManualGrant(lonely.id, null, grantInput(noHostPlan.id, true)), /No eligible/i, 'a plan whose only server is disabled is refused even with the override');
}

async function cleanup() {
  await query('DELETE FROM jellyfin_accounts WHERE customer_id=ANY($1::uuid[])', [created.customers]).catch(() => {});
  await query('DELETE FROM subscriptions WHERE customer_id=ANY($1::uuid[])', [created.customers]).catch(() => {});
  await query('DELETE FROM plans WHERE id=ANY($1::uuid[])', [created.plans]).catch(() => {});
  await query('DELETE FROM jellyfin_servers WHERE id=ANY($1::uuid[])', [created.servers]).catch(() => {});
  await query('DELETE FROM customers WHERE id=ANY($1::uuid[])', [created.customers]).catch(() => {});
}

main()
  .then(() => console.log('admin plan capacity override DB smoke: ok'))
  .catch(error => { console.error(error.stack || error); process.exitCode = 1; })
  .finally(async () => { await cleanup(); await getPool().end().catch(() => {}); process.exit(process.exitCode || 0); });
