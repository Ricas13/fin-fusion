'use strict';

// The admin "Re-check with Plisio" route, exercised over real HTTP against the assembled app:
// only Plisio checkouts may be re-checked (decided before anything is audited or contacted),
// unknown checkouts are refused, and an accepted attempt is audited before the provider is
// asked and again with its outcome.

require('dotenv').config();
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('billing re-check route DB smoke')) process.exit(0);

process.env.DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.JELLYFIN_ENCRYPTION_KEY ||= '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.SESSION_SECRET ||= 'recheck-route-smoke-session-secret-0123456789';
process.env.NODE_ENV ||= 'test';

const assert = require('assert');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, getPool } = require('../src/db');
const runtimeSettings = require('../src/platform/runtime-settings');
const { createApplication } = require('../src/application');

const suffix = crypto.randomBytes(5).toString('hex');
const PASSWORD = `Recheck-${suffix}-Pw!9`;
let adminId = null;
let previousPlatform = null;
const customers = [];
const intents = [];

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

async function makeIntent(provider) {
  const customer = (await query('INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id', [`Recheck ${provider} ${suffix}`, `recheck-${provider}-${suffix}@example.invalid`])).rows[0].id;
  customers.push(customer);
  const row = await query(`
    INSERT INTO billing_checkout_intents(scope,customer_id,provider,checkout_mode,state,nonce_hash,provider_checkout_id,expires_at,created_at,commercial_snapshot)
    VALUES('customer',$1,$2,'payment','open',$3,$4,NOW()+INTERVAL '1 day',NOW()-INTERVAL '5 hours','{}'::jsonb) RETURNING id
  `, [customer, provider, `nonce-${provider}-${suffix}`, `${provider}-checkout-${suffix}`]);
  intents.push(row.rows[0].id);
  return row.rows[0].id;
}

async function auditCount(id, action) {
  return (await query('SELECT COUNT(*)::int n FROM audit_log WHERE entity_id=$1 AND action=$2', [id, action])).rows[0].n;
}

async function main() {
  previousPlatform = (await query(`SELECT setting_value FROM platform_settings WHERE setting_key='platform'`)).rows[0]?.setting_value ?? null;
  await query(`
    INSERT INTO platform_settings(setting_key,setting_value,updated_at)
    VALUES('platform',jsonb_build_object('requireAdminTwoFactor',false),NOW())
    ON CONFLICT(setting_key) DO UPDATE SET setting_value=COALESCE(platform_settings.setting_value,'{}'::jsonb)||jsonb_build_object('requireAdminTwoFactor',false)
  `);
  await runtimeSettings.reload();
  adminId = (await query(
    `INSERT INTO app_users(username,email,password_hash,role,active,legacy_numeric_id,is_owner,password_changed_at,email_verified_at)
     VALUES($1,$2,$3,'admin',TRUE,$4,TRUE,NOW(),NOW()) RETURNING id`,
    [`recheck-${suffix}`, `recheck-${suffix}@example.invalid`, await bcrypt.hash(PASSWORD, 10), 700000 + Math.floor(Math.random() * 90000)]
  )).rows[0].id;

  const app = createApplication();
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const j = jar();
    let res = await fetch(`${base}/login`, { redirect: 'manual' });
    j.set(res);
    const loginCsrf = (await res.text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
    res = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { cookie: j.get(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: loginCsrf, username: `recheck-${suffix}`, password: PASSWORD }).toString() });
    j.set(res);
    assert.strictEqual(res.status, 302, 'the administrator must be able to sign in');
    const page = await fetch(`${base}/admin/discounts`, { redirect: 'manual', headers: { cookie: j.get() } });
    const token = (await page.text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
    assert(token, 'the administrator must receive a CSRF token');
    const post = async (id, withToken = true) => {
      const r = await fetch(`${base}/admin/billing/checkouts/${id}/recheck`, { method: 'POST', redirect: 'manual', headers: { cookie: j.get(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(withToken ? { _csrf: token } : {}).toString() });
      return { status: r.status, location: decodeURIComponent(r.headers.get('location') || '') };
    };

    // CSRF is enforced.
    assert.strictEqual((await post(crypto.randomUUID(), false)).status, 403, 'a request without the CSRF token must be refused');

    // A malformed id and an unknown checkout are refused with a message.
    assert(/valid checkout/.test((await post('not-a-uuid')).location), 'a malformed id must be refused');
    const missing = await post(crypto.randomUUID());
    assert(/no longer exists/.test(missing.location), `an unknown checkout must be refused (${missing.location})`);

    // A Stripe checkout is refused before anything is audited or contacted.
    const stripeId = await makeIntent('stripe');
    const stripe = await post(stripeId);
    assert(/Only Plisio crypto checkouts/.test(stripe.location), `a non-Plisio checkout must be refused (${stripe.location})`);
    assert.strictEqual(await auditCount(stripeId, 'billing.checkout.recheck'), 0, 'a refused checkout must not be audited as an attempt');

    // A Plisio checkout is accepted: the attempt and its outcome are both audited. Plisio is not
    // configured in this database, so the recovery run has nothing to contact.
    const plisioId = await makeIntent('plisio');
    const plisio = await post(plisioId);
    assert(plisio.location.startsWith('/admin/commerce/orders?message='), `a Plisio checkout must be accepted (${plisio.location})`);
    assert.strictEqual(await auditCount(plisioId, 'billing.checkout.recheck'), 1, 'the attempt must be audited');
    assert.strictEqual(await auditCount(plisioId, 'billing.checkout.recheck_result'), 1, 'the outcome must be audited');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

async function cleanup() {
  await query('DELETE FROM billing_checkout_intents WHERE id=ANY($1::uuid[])', [intents]).catch(() => {});
  await query('DELETE FROM customers WHERE id=ANY($1::uuid[])', [customers]).catch(() => {});
  await query('DELETE FROM auth_sessions WHERE user_id=$1', [adminId]).catch(() => {});
  await query('DELETE FROM app_users WHERE id=$1', [adminId]).catch(() => {});
  if (previousPlatform) await query(`UPDATE platform_settings SET setting_value=$1::jsonb,updated_at=NOW() WHERE setting_key='platform'`, [JSON.stringify(previousPlatform)]).catch(() => {});
  else await query(`DELETE FROM platform_settings WHERE setting_key='platform'`).catch(() => {});
  await runtimeSettings.reload().catch(() => {});
}

main()
  .then(() => console.log('billing re-check route DB smoke: ok'))
  .catch(error => { console.error(error.stack || error); process.exitCode = 1; })
  .finally(async () => { await cleanup(); await getPool().end().catch(() => {}); process.exit(process.exitCode || 0); });
