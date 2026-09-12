'use strict';

// Regression test for a real bug: src/jellyfin/manual-assignment.js's assign()
// and src/jellyfin/admin-force-move.js's move() used to read the customer's
// current Jellyfin accounts and then create/reuse one without holding the same
// per-customer advisory lock the automatic reconciler (resilient-provisioning.js)
// uses. An admin action and a concurrently-running automatic reconcile for the
// same customer could each independently decide "this customer needs a primary
// account" and both create one - one delivered to the customer, one silently
// created on a different server, consuming capacity and never cleaned up.
//
// This test proves the lock is actually engaged: it holds the exact advisory
// lock key manual-assignment.js/admin-force-move.js now depend on, calls
// assign()/move(), and confirms each has NOT yet mutated jellyfin_accounts
// while the lock is held elsewhere, then releases the lock and confirms the
// call completes and the mutation lands.
//
// It also proves the operator FORCE semantics: a deliberate manual assignment
// must still create the account on the selected server when max_users has
// already been reached. Capacity protects automatic placement, not admin force.
//
// reconciliation-lock.js acquires via pg_try_advisory_lock in a poll loop
// (never a blocking pg_advisory_lock), so a contended attempt never shows as a
// "waiting" row in pg_locks - each try is instantaneous, granted or not. The
// mutation-hasn't-happened-yet check is the only reliable external observation.

const assert = require('assert');
const crypto = require('crypto');
const { Client } = require('pg');
const { query } = require('../src/db');
const registry = require('../src/jellyfin/registry');

let nextUserId = 0;
registry.request = async (serverId, endpoint, options = {}) => {
  const method = options.method || 'GET';
  if (endpoint === '/Users/New' && method === 'POST') {
    nextUserId += 1;
    return { Id: `lock-guard-user-${nextUserId}`, Name: options.body?.Name || 'lock-guard-user', Policy: {} };
  }
  if (/^\/Users\/[^/]+\/Policy$/.test(endpoint)) return {};
  if (/^\/Users\/[^/]+$/.test(endpoint) && method === 'GET') return { Id: 'existing', Name: 'existing', Policy: {} };
  if (endpoint === '/Library/VirtualFolders') return [];
  if (endpoint === '/Users') return [{ Id: 'lock-guard-admin', Name: 'lock-guard-admin', Policy: { IsAdministrator: true } }];
  return {};
};

const manualAssignment = require('../src/jellyfin/manual-assignment');
const adminForceMove = require('../src/jellyfin/admin-force-move');

const LOCK_NAMESPACE = 761932;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function main() {
  const tag = `lock-guard-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

  async function addServer(suffix) {
    const row = (await query(`
      INSERT INTO jellyfin_servers(name,slug,server_class,base_url,public_url,api_key_encrypted,enabled,priority,max_users,health_status,allow_new_users,trial_enabled,paid_enabled)
      VALUES($1,$2,'premium',$3,$3,'not-used',TRUE,100,100,'healthy',TRUE,TRUE,TRUE) RETURNING id
    `, [`${tag}-${suffix}`, `${tag}-${suffix}`, `https://${tag}-${suffix}.example.invalid`])).rows[0];
    return row.id;
  }

  const server = await addServer('server');
  const plan = (await query(`
    INSERT INTO plans(code,name,description,audience,billing_interval,duration_days,price_minor,currency,streams,
      allow_downloads,allow_video_transcoding,allow_audio_transcoding,allow_live_tv,allow_live_tv_management,
      server_class,active,visible,sort_order,service_type)
    VALUES($1,'Lock guard plan','','direct','month',30,600,'USD',1,FALSE,FALSE,TRUE,TRUE,FALSE,'premium',TRUE,TRUE,10,'jellyfin')
    RETURNING id
  `, [`${tag}-plan`])).rows[0];

  async function customerWithActivePlan(name) {
    const customer = (await query(`INSERT INTO customers(display_name,note) VALUES($1,'test') RETURNING id`, [name])).rows[0];
    await query(`
      INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,service_type_snapshot,billing_mode)
      VALUES($1,$2,'active','manual',NOW()-INTERVAL '1 day',NOW()+INTERVAL '29 days','jellyfin','manual')
    `, [customer.id, plan.id]);
    return customer.id;
  }

  // --- assign(): must not create an account while the customer's lock is held elsewhere ---
  {
    const customerId = await customerWithActivePlan(`${tag}-assign`);
    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock($1::int,hashtext($2::text))', [LOCK_NAMESPACE, customerId]);

    const pending = manualAssignment.assign(customerId, server, {}).catch(error => ({ __error: error }));
    await sleep(600);
    const during = await query(`SELECT 1 FROM jellyfin_accounts WHERE customer_id=$1 LIMIT 1`, [customerId]);
    assert.strictEqual(during.rowCount, 0, 'assign() must not create a Jellyfin account while another reconciliation for this customer is running');

    await holder.query('SELECT pg_advisory_unlock($1::int,hashtext($2::text))', [LOCK_NAMESPACE, customerId]);
    await holder.end();

    const outcome = await pending;
    assert(!outcome || !outcome.__error, `assign() must complete successfully once the lock is released: ${outcome && outcome.__error && outcome.__error.message}`);
    const after = await query(`SELECT 1 FROM jellyfin_accounts WHERE customer_id=$1 LIMIT 1`, [customerId]);
    assert.strictEqual(after.rowCount > 0, true, 'assign() must actually create the account once the lock clears');
  }

  // --- assign(): explicit admin FORCE must ignore max_users on the selected server ---
  {
    await query(`UPDATE jellyfin_servers SET max_users=1 WHERE id=$1`, [server]);
    const before = await query(`SELECT COUNT(*)::int AS n FROM jellyfin_accounts WHERE server_id=$1 AND disabled=FALSE AND account_purpose='jellyfin'`, [server]);
    assert(Number(before.rows[0]?.n || 0) >= 1, 'force-capacity regression fixture did not make the selected server full');

    const customerId = await customerWithActivePlan(`${tag}-force-full-server`);
    const outcome = await manualAssignment.assign(customerId, server, {});
    assert.strictEqual(String(outcome.server.id), String(server), 'forced assignment changed the administrator-selected server');
    assert.strictEqual(outcome.capacityOverride, true, 'forced assignment did not report the capacity override');

    const created = await query(`SELECT server_id,disabled FROM jellyfin_accounts WHERE customer_id=$1 AND account_purpose='jellyfin' ORDER BY updated_at DESC LIMIT 1`, [customerId]);
    assert.strictEqual(created.rowCount, 1, 'forced assignment did not create the Jellyfin account on a full server');
    assert.strictEqual(String(created.rows[0].server_id), String(server), 'forced assignment created the account on a different server');
    assert.strictEqual(created.rows[0].disabled, false, 'forced assignment created a disabled Jellyfin account');
  }

  // --- move(): must not touch the account's server while the customer's lock is held elsewhere ---
  {
    const customerId = await customerWithActivePlan(`${tag}-move`);
    await query(`INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,is_primary) VALUES($1,$2,$3,$3,TRUE)`, [customerId, server, `${tag}-existing`]);
    const otherServer = await addServer('server2');

    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock($1::int,hashtext($2::text))', [LOCK_NAMESPACE, customerId]);

    const pending = adminForceMove.move(customerId, otherServer, {}).catch(error => ({ __error: error }));
    await sleep(600);
    const during = await query(`SELECT server_id FROM jellyfin_accounts WHERE customer_id=$1 AND is_primary=TRUE LIMIT 1`, [customerId]);
    assert.strictEqual(String(during.rows[0]?.server_id), String(server), 'move() must not move the account while another reconciliation for this customer is running');

    await holder.query('SELECT pg_advisory_unlock($1::int,hashtext($2::text))', [LOCK_NAMESPACE, customerId]);
    await holder.end();

    const outcome = await pending;
    assert(!outcome || !outcome.__error, `move() must complete successfully once the lock is released: ${outcome && outcome.__error && outcome.__error.message}`);
    const after = await query(`SELECT server_id FROM jellyfin_accounts WHERE customer_id=$1 AND is_primary=TRUE LIMIT 1`, [customerId]);
    assert.strictEqual(String(after.rows[0]?.server_id), String(otherServer), 'move() must actually move the account once the lock clears');
  }

  console.log('admin jellyfin assignment/move reconciliation lock + force capacity db smoke: ok');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
