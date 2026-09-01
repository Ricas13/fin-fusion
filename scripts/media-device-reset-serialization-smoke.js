'use strict';

const assert = require('assert');
const express = require('express');
const db = require('../src/db');
const routeRateLimit = require('../src/security/route-rate-limit');
const deviceAccessPolicy = require('../src/jellyfin/device-access-policy');

const originalGetPool = db.getPool;
const originalQuery = db.query;
const originalMiddleware = routeRateLimit.middleware;
const originalReset = deviceAccessPolicy.resetAccountDevices;

const CUSTOMER_ID = '00000000-0000-0000-0000-000000000101';
const ACCOUNT_ID = '00000000-0000-0000-0000-000000000102';
const SERVER_ID = '00000000-0000-0000-0000-000000000103';

(async () => {
  const sequence = [];
  let lockHeld = false;
  let attempts = 0;
  let audit = null;

  const client = {
    async query(sql) {
      if (String(sql).includes('pg_try_advisory_lock')) {
        attempts += 1;
        if (attempts === 1) {
          sequence.push('try-lock:busy');
          return { rows: [{ locked: false }] };
        }
        lockHeld = true;
        sequence.push('try-lock:acquired');
        return { rows: [{ locked: true }] };
      }
      if (String(sql).includes('pg_advisory_unlock')) {
        sequence.push('unlock');
        lockHeld = false;
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      throw new Error(`Unexpected lock SQL: ${sql}`);
    },
    release() { sequence.push('release'); }
  };

  db.getPool = () => ({ connect: async () => client });
  db.query = async (sql, params) => {
    if (!String(sql).includes('INSERT INTO audit_log')) throw new Error(`Unexpected route SQL: ${sql}`);
    sequence.push('audit');
    audit = { sql: String(sql), params };
    return { rowCount: 1, rows: [] };
  };
  routeRateLimit.middleware = () => (_req, _res, next) => next();
  deviceAccessPolicy.resetAccountDevices = async (customerId, accountId) => {
    assert.strictEqual(lockHeld, true, 'admin reset must hold the same media-identity advisory lock as the activity worker');
    assert.strictEqual(customerId, CUSTOMER_ID);
    assert.strictEqual(accountId, ACCOUNT_ID);
    sequence.push('reset');
    return {
      account: { server_id: SERVER_ID, media_server_type: 'emby', device_limit: 1 },
      previousDevices: [{ device_id: 'old-device' }]
    };
  };

  delete require.cache[require.resolve('../src/platform/admin-media-controls')];
  const { createAdminMediaControlsRouter } = require('../src/platform/admin-media-controls');

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    req.session = {
      authUserId: '00000000-0000-0000-0000-000000000001',
      authRole: 'admin',
      adminId: '00000000-0000-0000-0000-000000000002',
      csrfToken: 'device-reset-test-token'
    };
    next();
  });
  app.use(createAdminMediaControlsRouter());

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/admin/media-controls/customer/${CUSTOMER_ID}/devices/${ACCOUNT_ID}/reset`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: 'device-reset-test-token' })
    });

    assert.strictEqual(response.status, 302, 'mounted registered-device reset must redirect after success');
    assert((response.headers.get('location') || '').includes('Registered%20device%20access%20reset'), 'success redirect must explain that registered device access was reset');
    assert.deepStrictEqual(sequence.slice(0, 4), ['try-lock:busy', 'try-lock:acquired', 'reset', 'unlock'], 'reset must wait for worker ownership, mutate while locked, then release the lock');
    assert(sequence.indexOf('reset') < sequence.indexOf('unlock'), 'reset must finish before the activity-worker lock is released');
    assert(audit && audit.sql.includes('admin.media_device_access.reset'), 'mounted reset must write the existing admin audit event');
    assert.strictEqual(audit.params[1], ACCOUNT_ID, 'audit must identify the reset Jellyfin/Emby account');

    const invalid = await fetch(`http://127.0.0.1:${port}/admin/media-controls/customer/${CUSTOMER_ID}/devices/${ACCOUNT_ID}/reset`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: 'wrong-token' })
    });
    assert.strictEqual(invalid.status, 403, 'mounted registered-device reset must still reject invalid CSRF');
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.getPool = originalGetPool;
    db.query = originalQuery;
    routeRateLimit.middleware = originalMiddleware;
    deviceAccessPolicy.resetAccountDevices = originalReset;
    delete require.cache[require.resolve('../src/platform/admin-media-controls')];
  }

  console.log('media device reset serialization mounted smoke: ok');
})().catch(error => {
  db.getPool = originalGetPool;
  db.query = originalQuery;
  routeRateLimit.middleware = originalMiddleware;
  deviceAccessPolicy.resetAccountDevices = originalReset;
  console.error(error);
  process.exit(1);
});