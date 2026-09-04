'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { query } = require('../src/db');
const registry = require('../src/jellyfin/registry');
const durableCreation = require('../src/jellyfin/durable-account-creation');
const { encryptWithEnv } = require('../src/security/purpose-crypto');

async function run() {
  const tag = `jf-create-recovery-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  let customerId = null;
  let serverId = null;
  const originalRequest = registry.request;
  const remoteUsers = [];
  let createCalls = 0;
  let failRecoveryListOnce = false;

  try {
    const customer = await query(`
      INSERT INTO customers(display_name,email,registration_source)
      VALUES($1,$2,'public')
      RETURNING id
    `, [`${tag}-viewer`, `${tag}@example.test`]);
    customerId = customer.rows[0].id;

    const apiKey = encryptWithEnv(`test-${tag}`, 'JELLYFIN_ENCRYPTION_KEY', 'jf1');
    const server = await query(`
      INSERT INTO jellyfin_servers(
        name,slug,server_class,media_server_type,base_url,public_url,api_key_encrypted,
        enabled,priority,max_users,health_status,allow_new_users,trial_enabled,paid_enabled,placement_mode
      )
      VALUES($1,$2,'free','jellyfin','https://example.invalid','https://example.invalid',$3,
             TRUE,1,100,'healthy',TRUE,TRUE,TRUE,'active')
      RETURNING *
    `, [`${tag}-server`, `${tag}-server`, apiKey]);
    serverId = server.rows[0].id;

    registry.request = async (_serverId, path, options = {}) => {
      if (path === '/Users') {
        if (failRecoveryListOnce) {
          failRecoveryListOnce = false;
          const error = new Error('simulated network loss while checking an ambiguous create');
          error.code = 'JELLYFIN_REQUEST_FAILED';
          error.retryable = true;
          throw error;
        }
        return remoteUsers.map(user => ({ ...user }));
      }
      if (path === '/Users/New') {
        createCalls += 1;
        assert.equal(options.method, 'POST');
        const created = { Id: `${tag}-remote-1`, Name: options.body.Name };
        remoteUsers.push(created);
        // Simulate the worst normal distributed-system case: Jellyfin created
        // the user, but CAPTAiNFiN never received the HTTP response and then
        // also lost connectivity during its immediate ambiguity check.
        failRecoveryListOnce = true;
        const error = new Error('simulated POST response timeout after remote success');
        error.code = 'JELLYFIN_TIMEOUT';
        error.retryable = true;
        throw error;
      }
      if (/^\/Users\/[^/]+$/.test(path)) {
        const id = decodeURIComponent(path.split('/').pop());
        const found = remoteUsers.find(user => user.Id === id);
        if (!found) throw new Error('Jellyfin request failed (404)');
        return { ...found };
      }
      if (/\/Policy$/.test(path)) return {};
      throw new Error(`Unexpected Jellyfin smoke path: ${path}`);
    };

    const effective = {
      unrestricted: true,
      visibleNames: [],
      technical: {
        streams: 1,
        allow_remote_access: true,
        allow_audio_transcoding: true,
        allow_video_transcoding: true,
        allow_remuxing: true,
        allow_downloads: false,
        allow_live_tv_management: false,
        allow_live_tv: false,
        allow_subtitle_editing: false
      }
    };

    let firstError = null;
    try {
      await durableCreation.createJellyfinAccount(customerId, server.rows[0], effective, { makePrimary: false });
    } catch (error) {
      firstError = error;
    }
    assert(firstError, 'ambiguous create did not surface the temporary network failure');
    assert.equal(createCalls, 1, 'first provisioning attempt issued an unexpected number of remote creates');
    assert.equal(remoteUsers.length, 1, 'simulated Jellyfin did not retain exactly one created user');
    const uncertain = (await query(`
      SELECT status,remote_user_id,username FROM jellyfin_account_creation_intents
      WHERE customer_id=$1 AND server_id=$2
    `, [customerId, serverId])).rows[0];
    assert(uncertain, 'ambiguous create did not persist a restart-safe creation intent');
    assert.equal(uncertain.status, 'uncertain', 'ambiguous create was not marked uncertain for recovery');
    assert(!uncertain.remote_user_id, 'ambiguous response incorrectly claimed to know the remote user id');

    // This second call is equivalent to a later worker run after a process
    // restart: only PostgreSQL and Jellyfin state survive. It must adopt the
    // exact remotely-created username instead of POSTing /Users/New again.
    const recovered = await durableCreation.createJellyfinAccount(customerId, server.rows[0], effective, { makePrimary: false });
    assert(recovered?.id, 'retry did not persist the recovered Jellyfin account');
    assert.equal(createCalls, 1, 'retry created a duplicate remote Jellyfin user');
    assert.equal(remoteUsers.length, 1, 'retry left more than one remote Jellyfin user');
    assert.equal(recovered.jellyfin_user_id, remoteUsers[0].Id, 'retry did not adopt the original remote user id');
    assert.equal(recovered.jellyfin_username, remoteUsers[0].Name, 'retry did not adopt the original reserved username');

    const localCount = await query(`SELECT COUNT(*)::int AS count FROM jellyfin_accounts WHERE customer_id=$1 AND server_id=$2`, [customerId, serverId]);
    assert.equal(Number(localCount.rows[0].count), 1, 'recovery persisted more than one local Jellyfin account');
    const remainingIntent = await query(`SELECT 1 FROM jellyfin_account_creation_intents WHERE customer_id=$1 AND server_id=$2`, [customerId, serverId]);
    assert.equal(remainingIntent.rowCount, 0, 'successful recovery left a stale creation intent');

    console.log('Jellyfin ambiguous-create restart recovery DB smoke: ok');
  } finally {
    registry.request = originalRequest;
    if (customerId) {
      await query(`DELETE FROM jellyfin_account_creation_intents WHERE customer_id=$1`, [customerId]).catch(() => {});
      await query(`DELETE FROM jellyfin_accounts WHERE customer_id=$1`, [customerId]).catch(() => {});
      await query(`DELETE FROM customers WHERE id=$1`, [customerId]).catch(() => {});
    }
    if (serverId) await query(`DELETE FROM jellyfin_servers WHERE id=$1`, [serverId]).catch(() => {});
  }
}

if (require.main === module) {
  run().then(() => process.exit(0)).catch(error => {
    console.error(error.stack || error);
    process.exit(1);
  });
}

module.exports = { run };
