'use strict';

// End-to-end regression for middleware ORDER in the real application. The owner-only
// boundary and the step-up (fresh 2FA) guard used to be mounted after the security,
// branding, claims and preview routers, so owner-only routes served by those routers were
// reachable by a support administrator and POST /admin/security/2fa-policy skipped step-up.

require('dotenv').config();
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('admin owner boundary order DB smoke')) process.exit(0);

process.env.DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.JELLYFIN_ENCRYPTION_KEY ||= '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.SESSION_SECRET ||= 'owner-boundary-order-smoke-session-secret-0123456789';
process.env.NODE_ENV ||= 'test';

const assert = require('assert');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, getPool } = require('../src/db');
const runtimeSettings = require('../src/platform/runtime-settings');
const { createApplication } = require('../src/application');

const suffix = crypto.randomBytes(5).toString('hex');
const PASSWORD = `Owner-Boundary-${suffix}-Pw!9`;
const users = [];
let previousPlatform = null;

async function createAdmin(label, isOwner, legacyId) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const row = (await query(
    `INSERT INTO app_users(username,email,password_hash,role,active,legacy_numeric_id,is_owner,password_changed_at,email_verified_at)
     VALUES($1,$2,$3,'admin',TRUE,$4,$5,NOW(),NOW()) RETURNING id`,
    [`boundary-${label}-${suffix}`, `boundary-${label}-${suffix}@example.invalid`, hash, legacyId, isOwner]
  )).rows[0];
  users.push(row.id);
  return { id: row.id, username: `boundary-${label}-${suffix}` };
}

function jar() {
  let cookie = '';
  return {
    get: () => cookie,
    set(res) {
      for (const header of res.headers.getSetCookie?.() || []) {
        const pair = header.split(';')[0];
        const name = pair.split('=')[0];
        cookie = cookie.split('; ').filter(part => part && !part.startsWith(`${name}=`)).concat(pair).join('; ');
      }
    }
  };
}

async function main() {
  previousPlatform = (await query(`SELECT setting_value FROM platform_settings WHERE setting_key='platform'`)).rows[0]?.setting_value ?? null;
  await query(`
    INSERT INTO platform_settings(setting_key,setting_value,updated_at)
    VALUES('platform',jsonb_build_object('requireAdminTwoFactor',false),NOW())
    ON CONFLICT(setting_key) DO UPDATE SET setting_value=COALESCE(platform_settings.setting_value,'{}'::jsonb)||jsonb_build_object('requireAdminTwoFactor',false)
  `);
  await runtimeSettings.reload();

  const legacyBase = 800000 + Math.floor(Math.random() * 100000);
  const owner = await createAdmin('owner', true, legacyBase);
  const support = await createAdmin('support', false, legacyBase + 1);

  const app = createApplication();
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function session(user) {
    const j = jar();
    let res = await fetch(`${base}/login`, { redirect: 'manual' });
    j.set(res);
    const csrf = (await res.text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
    res = await fetch(`${base}/login`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: j.get(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, username: user.username, password: PASSWORD }).toString()
    });
    j.set(res);
    assert.strictEqual(res.status, 302, `${user.username} must be able to sign in (got ${res.status})`);
    const page = await fetch(`${base}/admin/discounts`, { redirect: 'manual', headers: { cookie: j.get() } });
    const token = (await page.text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
    assert(token, `${user.username} must receive a CSRF token`);
    return async (path, fields = {}) => {
      const res2 = await fetch(`${base}${path}`, {
        method: 'POST', redirect: 'manual',
        headers: { cookie: j.get(), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: token, ...fields }).toString()
      });
      return { status: res2.status, location: res2.headers.get('location') || '', text: res2.status === 302 ? '' : await res2.text() };
    };
  }

  try {
    const asSupport = await session(support);
    const asOwner = await session(owner);

    // Owner-only routes served by routers mounted before mountAdminRoutes().
    for (const path of ['/admin/security/2fa-policy', '/admin/settings/branding/logo/remove', '/admin/settings/branding/favicon/remove']) {
      const denied = await asSupport(path);
      assert.strictEqual(denied.status, 403, `support admin must be refused ${path} (got ${denied.status} ${denied.location})`);
      assert(/Owner access/.test(denied.text), `${path} must be refused by the owner boundary`);
    }
    assert.strictEqual((await runtimeSettings.requireAdminTwoFactor()), false, 'a refused support request must not change the 2FA policy');

    // The owner is not blocked by the boundary.
    const allowed = await asOwner('/admin/security/2fa-policy', { requireAdminTwoFactor: 'on' });
    assert.strictEqual(allowed.status, 302);
    assert(/admin-2fa/.test(allowed.location) && /message=/.test(allowed.location), `owner must be able to set the policy (got ${allowed.location})`);
    assert.strictEqual(runtimeSettings.requireAdminTwoFactor(), true, 'the owner request must change the policy');

    // Step-up must run for the policy route: once the owner has TOTP enrolled but no fresh
    // step-up, the change is redirected to the step-up page instead of being applied.
    await query(`UPDATE app_users SET totp_enabled=TRUE WHERE id=$1`, [owner.id]);
    const stepped = await asOwner('/admin/security/2fa-policy', { requireAdminTwoFactor: '' });
    assert([302, 303].includes(stepped.status), `step-up must redirect (got ${stepped.status})`);
    assert(/\/admin\/security\/step-up/.test(stepped.location), `2fa-policy must require a fresh step-up (got ${stepped.location})`);
    assert.strictEqual(runtimeSettings.requireAdminTwoFactor(), true, 'a request without step-up must not change the policy');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

async function cleanup() {
  await query(`DELETE FROM auth_sessions WHERE user_id=ANY($1::uuid[])`, [users]).catch(() => {});
  await query(`DELETE FROM app_users WHERE id=ANY($1::uuid[])`, [users]).catch(() => {});
  if (previousPlatform) {
    await query(`UPDATE platform_settings SET setting_value=$1::jsonb,updated_at=NOW() WHERE setting_key='platform'`, [JSON.stringify(previousPlatform)]).catch(() => {});
  } else {
    await query(`DELETE FROM platform_settings WHERE setting_key='platform'`).catch(() => {});
  }
  await runtimeSettings.reload().catch(() => {});
}

main()
  .then(() => console.log('admin owner boundary order DB smoke: ok'))
  .catch(error => { console.error(error.stack || error); process.exitCode = 1; })
  .finally(async () => { await cleanup(); await getPool().end().catch(() => {}); process.exit(process.exitCode || 0); });
