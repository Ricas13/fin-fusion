'use strict';

// Over real HTTP: when Add plan manually or Change plan is refused only because the plan is full, the administrator
// is asked "this plan is full, add anyway?" and NOTHING changes until they confirm. Confirming re-submits the same
// form with the capacity override. Any other error is unaffected.

require('dotenv').config();
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('admin plan full confirmation DB smoke')) process.exit(0);

process.env.DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.JELLYFIN_ENCRYPTION_KEY ||= '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.SESSION_SECRET ||= 'full-confirm-smoke-session-secret-0123456789';
process.env.NODE_ENV ||= 'test';

const assert = require('assert');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, getPool } = require('../src/db');
const runtimeSettings = require('../src/platform/runtime-settings');
const { createApplication } = require('../src/application');
const { unique, fixtureCustomer, fixturePlan, fixtureSubscription } = require('./test-fixture');

const suffix = crypto.randomBytes(5).toString('hex');
const PASSWORD = `Confirm-${suffix}-Pw!9`;
const created = { customers: [], plans: [], servers: [] };
let adminId = null, previousPlatform = null;

function jar() {
  let cookie = '';
  return { get: () => cookie, set(res) { for (const header of res.headers.getSetCookie?.() || []) { const pair = header.split(';')[0]; const name = pair.split('=')[0]; cookie = cookie.split('; ').filter(part => part && !part.startsWith(`${name}=`)).concat(pair).join('; '); } } };
}

async function main() {
  previousPlatform = (await query(`SELECT setting_value FROM platform_settings WHERE setting_key='platform'`)).rows[0]?.setting_value ?? null;
  await query(`INSERT INTO platform_settings(setting_key,setting_value,updated_at) VALUES('platform',jsonb_build_object('requireAdminTwoFactor',false),NOW()) ON CONFLICT(setting_key) DO UPDATE SET setting_value=COALESCE(platform_settings.setting_value,'{}'::jsonb)||jsonb_build_object('requireAdminTwoFactor',false)`);
  await runtimeSettings.reload();
  adminId = (await query(`INSERT INTO app_users(username,email,password_hash,role,active,legacy_numeric_id,is_owner,password_changed_at,email_verified_at) VALUES($1,$2,$3,'admin',TRUE,$4,TRUE,NOW(),NOW()) RETURNING id`, [`confirm-${suffix}`, `confirm-${suffix}@example.invalid`, await bcrypt.hash(PASSWORD, 10), 700000 + Math.floor(Math.random() * 90000)])).rows[0].id;

  // A plan restricted to one server that has reached its user limit: full regardless of any other servers.
  const fullPlan = await fixturePlan({ query }, { code: unique('confirm-full'), name: 'Full Confirm Plan', serviceType: 'jellyfin', audience: 'direct', billingInterval: 'month', durationDays: 30, priceMinor: 0, currency: 'GBP', streams: 1, serverClass: 'premium', capacityLimit: 50 });
  created.plans.push(fullPlan.id);
  const tight = (await query(`INSERT INTO jellyfin_servers(name,slug,server_class,base_url,public_url,location,api_key_encrypted,enabled,allow_new_users,paid_enabled,trial_enabled,priority,max_users,health_status,last_health_check) VALUES($1,$1,'premium','https://confirm.example.invalid','https://confirm.example.invalid','Confirm','key',TRUE,TRUE,TRUE,TRUE,10,1,'healthy',NOW()) RETURNING id`, [unique('confirm-server')])).rows[0].id;
  created.servers.push(tight);
  await query('INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,100)', [fullPlan.id, tight]);
  const occupant = await fixtureCustomer({ query }, { displayName: 'Occupant', email: `${unique('occ')}@example.invalid` });
  created.customers.push(occupant.id);
  await query(`INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,account_purpose) VALUES($1,$2,$3,$4,FALSE,'jellyfin')`, [occupant.id, tight, unique('jfu'), unique('occ')]);

  const target = await fixtureCustomer({ query }, { displayName: 'Grant Target', email: `${unique('target')}@example.invalid` });
  const mover = await fixtureCustomer({ query }, { displayName: 'Plan Mover', email: `${unique('mover')}@example.invalid` });
  created.customers.push(target.id, mover.id);
  const startPlan = await fixturePlan({ query }, { code: unique('confirm-start'), name: 'Start Plan', serviceType: 'jellyfin', audience: 'direct', billingInterval: 'month', durationDays: 30, priceMinor: 0, currency: 'GBP', streams: 1, serverClass: 'premium', capacityLimit: 50 });
  created.plans.push(startPlan.id);
  const moverSub = await fixtureSubscription({ query }, { customerId: mover.id, planId: startPlan.id, source: 'admin_grant', billingMode: 'manual' });

  const app = createApplication();
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const j = jar();
    let res = await fetch(`${base}/login`, { redirect: 'manual' });
    j.set(res);
    const loginCsrf = (await res.text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
    res = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { cookie: j.get(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: loginCsrf, username: `confirm-${suffix}`, password: PASSWORD }).toString() });
    j.set(res);
    assert.strictEqual(res.status, 302, 'the administrator can sign in');
    const token = (await (await fetch(`${base}/admin/discounts`, { redirect: 'manual', headers: { cookie: j.get() } })).text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
    assert(token, 'CSRF token');
    const post = async (path, fields) => {
      const r = await fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers: { cookie: j.get(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: token, ...fields }).toString() });
      return { status: r.status, location: decodeURIComponent(r.headers.get('location') || ''), html: r.status === 200 ? await r.text() : '' };
    };
    const today = new Date().toISOString().slice(0, 10), later = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const grantFields = { planId: fullPlan.id, method: 'other', currency: 'GBP', amount: '0.00', confirm: '1', startDate: today, endDate: later, returnTab: 'access', note: 'confirm smoke' };

    // --- Add plan manually onto a full plan: asked, nothing granted.
    const asked = await post(`/admin/users/${target.id}/manual-grant`, grantFields);
    assert.strictEqual(asked.status, 200, `a full plan shows a confirmation page, not an error redirect (${asked.status} ${asked.location})`);
    assert(asked.html.includes('This plan is full') && asked.html.includes('data-capacity-confirm'), 'the page says the plan is full');
    assert(asked.html.includes('Nothing has been changed yet'), 'and that nothing has changed');
    assert(asked.html.includes('Yes, grant this plan anyway'), 'with an explicit confirm button');
    assert(asked.html.includes('name="allowOverCapacity" value="1"'), 'which switches the override on');
    for (const key of Object.keys(grantFields)) assert(asked.html.includes(`name="${key}" value="${grantFields[key]}"`), `the confirm form carries the original ${key}`);
    assert.strictEqual((await query('SELECT COUNT(*)::int n FROM subscriptions WHERE customer_id=$1', [target.id])).rows[0].n, 0, 'nothing was granted before confirming');

    // --- Confirm: the same form with the override.
    const confirmed = await post(`/admin/users/${target.id}/manual-grant`, { ...grantFields, allowOverCapacity: '1' });
    assert.strictEqual(confirmed.status, 302, 'confirming redirects back to the customer');
    assert(confirmed.location.includes('message=') && /capacity override/i.test(confirmed.location), `the result says it was an override (${confirmed.location})`);
    assert.strictEqual((await query(`SELECT COUNT(*)::int n FROM subscriptions WHERE customer_id=$1 AND plan_id=$2 AND status='active'`, [target.id, fullPlan.id])).rows[0].n, 1, 'the customer now holds the plan');
    assert.strictEqual((await query(`SELECT metadata FROM audit_log WHERE action='admin.customer.manual_grant' AND metadata->>'planCode'=$1`, [fullPlan.code])).rows[0].metadata.capacityOverride, true, 'and the override is audited');

    // --- A different error is not turned into a capacity prompt.
    const other = await fixtureCustomer({ query }, { displayName: 'Other', email: `${unique('other')}@example.invalid` });
    created.customers.push(other.id);
    const bad = await post(`/admin/users/${other.id}/manual-grant`, { ...grantFields, currency: 'XXX' });
    assert.strictEqual(bad.status, 302, 'an unrelated error still redirects with an error message');
    assert(bad.location.includes('error='), 'carrying the error');

    // --- Change plan onto the full plan: asked, plan unchanged, then confirmed.
    const changeFields = { subscriptionId: moverSub.id, planId: fullPlan.id, confirmWord: 'MOVE' };
    const askedChange = await post(`/admin/users/${mover.id}/change-plan`, changeFields);
    assert.strictEqual(askedChange.status, 200, 'changing onto a full plan shows the confirmation page');
    assert(askedChange.html.includes('This plan is full') && askedChange.html.includes('Yes, move this subscription anyway'), 'with a confirm button');
    for (const key of Object.keys(changeFields)) assert(askedChange.html.includes(`name="${key}" value="${changeFields[key]}"`), `the confirm form carries the original ${key}`);
    assert.strictEqual(String((await query('SELECT plan_id FROM subscriptions WHERE id=$1', [moverSub.id])).rows[0].plan_id), String(startPlan.id), 'the plan is unchanged until confirmed');
    const changed = await post(`/admin/users/${mover.id}/change-plan`, { ...changeFields, allowOverCapacity: '1' });
    assert.strictEqual(changed.status, 303, 'confirming applies the change');
    assert.strictEqual(String((await query('SELECT plan_id FROM subscriptions WHERE id=$1', [moverSub.id])).rows[0].plan_id), String(fullPlan.id), 'the customer is on the full plan');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

async function cleanup() {
  await query('DELETE FROM jellyfin_accounts WHERE customer_id=ANY($1::uuid[])', [created.customers]).catch(() => {});
  await query('DELETE FROM subscriptions WHERE customer_id=ANY($1::uuid[])', [created.customers]).catch(() => {});
  await query('DELETE FROM customer_jellyfin_admin_control WHERE customer_id=ANY($1::uuid[])', [created.customers]).catch(() => {});
  await query('DELETE FROM plans WHERE id=ANY($1::uuid[])', [created.plans]).catch(() => {});
  await query('DELETE FROM customers WHERE id=ANY($1::uuid[])', [created.customers]).catch(() => {});
  await query('DELETE FROM jellyfin_servers WHERE id=ANY($1::uuid[])', [created.servers]).catch(error => console.warn('cleanup of test servers failed:', error.message));
  await query('DELETE FROM auth_sessions WHERE user_id=$1', [adminId]).catch(() => {});
  await query('DELETE FROM app_users WHERE id=$1', [adminId]).catch(() => {});
  if (previousPlatform) await query(`UPDATE platform_settings SET setting_value=$1::jsonb,updated_at=NOW() WHERE setting_key='platform'`, [JSON.stringify(previousPlatform)]).catch(() => {});
  else await query(`DELETE FROM platform_settings WHERE setting_key='platform'`).catch(() => {});
  await runtimeSettings.reload().catch(() => {});
}

main()
  .then(() => console.log('admin plan full confirmation DB smoke: ok'))
  .catch(error => { console.error(error.stack || error); process.exitCode = 1; })
  .finally(async () => { await cleanup(); await getPool().end().catch(() => {}); process.exit(process.exitCode || 0); });
