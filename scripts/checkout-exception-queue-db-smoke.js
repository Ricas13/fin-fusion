'use strict';

// Crypto checkouts that automation could not settle stay in the exception queue past the
// seven-day retry window until an administrator dismisses them or records them as paid. Both
// actions need a reason, are audited, cannot run twice, and recording a payment grants access
// through the normal Plisio activation path with an operator-confirmed (not provider-verified) ledger entry.

require('dotenv').config();
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('checkout exception queue DB smoke')) process.exit(0);

process.env.DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.JELLYFIN_ENCRYPTION_KEY ||= '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.SESSION_SECRET ||= 'recheck-route-smoke-session-secret-0123456789';
process.env.NODE_ENV ||= 'test';
process.env.PLISIO_SECRET_KEY ||= 'queue-smoke-key';
process.env.PLISIO_ENABLED = 'true';

const assert = require('assert');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, getPool } = require('../src/db');
const runtimeSettings = require('../src/platform/runtime-settings');
const { createApplication } = require('../src/application');
const adminOrders = require('../src/platform/admin-orders');
const intents = require('../src/payments/checkout-intents');
const recovery = require('../src/payments/provider-checkout-recovery');
const plisioModule = require('../src/payments/plisio');
const { fixtureCustomer, fixturePlan } = require('./test-fixture');


const suffix = crypto.randomBytes(5).toString('hex');
const PASSWORD = `Queue-${suffix}-Pw!9`;
let adminId = null, previousPlatform = null, serverId = null;
const customers = [], intentIds = [], plans = [];

function jar() {
  let cookie = '';
  return { get: () => cookie, set(res) { for (const header of res.headers.getSetCookie?.() || []) { const pair = header.split(';')[0]; const name = pair.split('=')[0]; cookie = cookie.split('; ').filter(part => part && !part.startsWith(`${name}=`)).concat(pair).join('; '); } } };
}

async function makeIntent(label, { ageDays = 10, provider = 'plisio' } = {}) {
  const owner = await fixtureCustomer({ query }, { displayName: `Queue ${label} ${suffix}`, email: `queue-${label}-${suffix}@example.invalid` });
  customers.push(owner.id);
  const plan = await fixturePlan({ query }, { code: `queue-${label}-${suffix}`, name: `Queue plan ${label}`, serviceType: 'jellyfin', audience: 'direct', billingInterval: 'month', durationDays: 30, priceMinor: 1000, currency: 'GBP', capacityLimit: 100, streams: 1, serverClass: 'premium' });
  plans.push(plan.id);
  await query('INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,100)', [plan.id, serverId]);
  const snapshot = { kind: 'direct_plan', planId: plan.id, planPriceId: null, planCode: plan.code, planName: plan.name, priceMinor: 1000, discountedMinor: 1000, currency: 'GBP', billingInterval: 'month', durationDays: 30, streams: 1, stremioHouseholdNetworkLimit: 1, provider, checkoutMode: 'payment', providerMappingId: null, providerMappingRecordId: null, mediaLocation: 'Queue' };
  const created = await intents.createIntent({ scope: 'customer', customerId: owner.id, planId: plan.id, provider, checkoutMode: 'payment', commercialSnapshot: snapshot });
  await intents.attachProviderCheckout(created.id, `QUEUE-${label}-${suffix}`);
  await query(`UPDATE billing_checkout_intents SET created_at=NOW()-($2||' days')::interval WHERE id=$1`, [created.id, String(ageDays)]);
  intentIds.push(created.id);
  return { id: created.id, customerId: owner.id, planId: plan.id };
}
const audits = async (id, action) => (await query('SELECT COUNT(*)::int n FROM audit_log WHERE entity_id=$1 AND action=$2', [id, action])).rows[0].n;
const inQueue = async id => (await adminOrders.checkoutIssues()).some(row => row.checkout_id === id);

async function main() {
  previousPlatform = (await query(`SELECT setting_value FROM platform_settings WHERE setting_key='platform'`)).rows[0]?.setting_value ?? null;
  await query(`INSERT INTO platform_settings(setting_key,setting_value,updated_at) VALUES('platform',jsonb_build_object('requireAdminTwoFactor',false),NOW()) ON CONFLICT(setting_key) DO UPDATE SET setting_value=COALESCE(platform_settings.setting_value,'{}'::jsonb)||jsonb_build_object('requireAdminTwoFactor',false)`);
  await runtimeSettings.reload();
  serverId = (await query(`INSERT INTO jellyfin_servers(name,slug,server_class,base_url,public_url,location,api_key_encrypted,enabled,allow_new_users,paid_enabled,priority,max_users,health_status,last_health_check) VALUES($1,$2,'premium','https://queue.example.invalid','https://queue.example.invalid','Queue','key',TRUE,TRUE,TRUE,10,1000,'healthy',NOW()) RETURNING id`, [`Queue ${suffix}`, `queue-${suffix}`])).rows[0].id;
  adminId = (await query(`INSERT INTO app_users(username,email,password_hash,role,active,legacy_numeric_id,is_owner,password_changed_at,email_verified_at) VALUES($1,$2,$3,'admin',TRUE,$4,TRUE,NOW(),NOW()) RETURNING id`, [`queue-${suffix}`, `queue-${suffix}@example.invalid`, await bcrypt.hash(PASSWORD, 10), 700000 + Math.floor(Math.random() * 90000)])).rows[0].id;

  const old = await makeIntent('old', { ageDays: 10 });
  const fresh = await makeIntent('fresh', { ageDays: 0 });
  const dismissable = await makeIntent('dismiss', { ageDays: 6 });
  const stripe = await makeIntent('stripe', { ageDays: 10, provider: 'stripe' });

  // Queue: no age limit; an old unresolved Plisio checkout is listed and labelled as past retries.
  const queue = await adminOrders.checkoutIssues();
  const oldRow = queue.find(row => row.checkout_id === old.id);
  assert(oldRow, 'a Plisio checkout older than the retry window must stay in the exception queue');
  assert(/Past automatic retries/.test(oldRow.last_error), 'an aged checkout must say automatic retries are over');
  assert(!queue.some(row => row.checkout_id === stripe.id), 'only Plisio checkouts appear in this queue');
  assert(!queue.some(row => row.checkout_id === fresh.id), 'a checkout still inside its payment window is not an exception');

  const app = createApplication();
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const j = jar();
    let res = await fetch(`${base}/login`, { redirect: 'manual' });
    j.set(res);
    const loginCsrf = (await res.text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
    res = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { cookie: j.get(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: loginCsrf, username: `queue-${suffix}`, password: PASSWORD }).toString() });
    j.set(res);
    assert.strictEqual(res.status, 302, 'the administrator must be able to sign in');
    const page = await fetch(`${base}/admin/discounts`, { redirect: 'manual', headers: { cookie: j.get() } });
    const token = (await page.text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
    assert(token, 'the administrator must receive a CSRF token');
    const post = async (id, action, fields = {}, withToken = true) => {
      const r = await fetch(`${base}/admin/billing/checkouts/${id}/${action}`, { method: 'POST', redirect: 'manual', headers: { cookie: j.get(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...(withToken ? { _csrf: token } : {}), ...fields }).toString() });
      return { status: r.status, location: decodeURIComponent(r.headers.get('location') || '') };
    };

    // The page offers both actions on the row.
    const html = await (await fetch(`${base}/admin/commerce/orders`, { headers: { cookie: j.get() } })).text();
    assert(html.includes(`/admin/billing/checkouts/${old.id}/mark-paid`) && html.includes(`/admin/billing/checkouts/${old.id}/dismiss`), 'the orders page must offer Record as paid and Dismiss for the aged checkout');

    // Guards.
    assert.strictEqual((await post(old.id, 'dismiss', { reason: 'abandoned invoice' }, false)).status, 403, 'CSRF is enforced');
    assert(/reason/i.test((await post(old.id, 'dismiss', { reason: 'no' })).location), 'dismissal needs a real reason');
    assert(/reason/i.test((await post(old.id, 'mark-paid', { reason: 'short', confirm: 'PAID' })).location), 'recording a payment needs a real reason');
    assert(/Type PAID/.test((await post(old.id, 'mark-paid', { reason: 'Plisio dashboard shows completed', confirm: 'yes' })).location), 'recording a payment needs the typed confirmation');
    assert(/Only Plisio/.test((await post(stripe.id, 'mark-paid', { reason: 'Plisio dashboard shows completed', confirm: 'PAID' })).location), 'non-Plisio checkouts are refused');
    assert.strictEqual((await query('SELECT COUNT(*)::int n FROM subscriptions WHERE customer_id=$1', [old.customerId])).rows[0].n, 0, 'refused requests grant nothing');
    assert(await inQueue(old.id), 'refused requests leave the checkout in the queue');

    // Dismiss: removes it, audits it, grants nothing, cannot repeat.
    const dismissed = await post(dismissable.id, 'dismiss', { reason: 'customer never paid, invoice long expired' });
    assert(dismissed.location.includes('message='), `dismissal must succeed (${dismissed.location})`);
    assert(!await inQueue(dismissable.id), 'a dismissed checkout leaves the queue');
    assert.strictEqual(await audits(dismissable.id, 'billing.checkout.dismissed'), 1, 'dismissal is audited');
    assert.strictEqual((await query('SELECT COUNT(*)::int n FROM subscriptions WHERE customer_id=$1', [dismissable.customerId])).rows[0].n, 0, 'dismissal grants no access');
    assert(/already/.test((await post(dismissable.id, 'dismiss', { reason: 'second attempt again' })).location), 'a dismissed checkout cannot be acted on twice');

    // A checkout still inside its payment window can be neither dismissed nor looks like an exception.
    assert(/cannot be dismissed/.test((await post(fresh.id, 'dismiss', { reason: 'customer might still be paying' })).location), 'a still-payable invoice cannot be dismissed');
    assert.strictEqual((await query('SELECT operator_resolution FROM billing_checkout_intents WHERE id=$1', [fresh.id])).rows[0].operator_resolution, null, 'and it is left untouched');

    // Dismissal and its audit row are one transaction: if the audit cannot be written, nothing is dismissed.
    const atomic = await makeIntent('atomic', { ageDays: 9 });
    await query(`CREATE OR REPLACE FUNCTION zz_block_dismiss_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='billing.checkout.dismissed' THEN RAISE EXCEPTION 'audit blocked for test'; END IF; RETURN NEW; END $$`);
    await query(`CREATE TRIGGER zz_block_dismiss_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION zz_block_dismiss_audit()`);
    try {
      const blocked = await post(atomic.id, 'dismiss', { reason: 'audit write will fail here' });
      assert(blocked.location.includes('error='), 'the failure is reported');
      assert.strictEqual((await query('SELECT operator_resolution FROM billing_checkout_intents WHERE id=$1', [atomic.id])).rows[0].operator_resolution, null, 'a dismissal whose audit failed must not take effect');
      assert(await inQueue(atomic.id), 'and the checkout stays in the queue');
    } finally {
      await query('DROP TRIGGER IF EXISTS zz_block_dismiss_audit ON audit_log');
      await query('DROP FUNCTION IF EXISTS zz_block_dismiss_audit()');
    }

    // A dismissed checkout that the customer later pays is still detected by the recovery worker and,
    // when Plisio confirms it, activates access and annotates the dismissal.
    assert.strictEqual((await recovery.candidates({ limit: 200, checkoutIntentIds: [dismissable.id] })).length, 1, 'the recovery worker keeps polling a dismissed checkout inside its lookback');
    const realFetch = global.fetch;
    global.fetch = async (url, options) => {
      const u = new URL(String(url));
      if (u.hostname !== 'api.plisio.net') return realFetch(url, options);
      const id = decodeURIComponent(u.pathname.split('/').pop());
      return new Response(JSON.stringify({ status: 'success', data: { txn_id: id, id, type: 'invoice', status: 'completed', invoice_total_sum: '0.0006' } }), { status: 200 });
    };
    try {
      const dismissedIntent = await intents.findById(dismissable.id);
      const late = await plisioModule.confirmCheckout(dismissedIntent.provider_checkout_id, dismissedIntent);
      assert.strictEqual(late.completed, true, 'a payment confirmed after dismissal still activates access');
    } finally { global.fetch = realFetch; }
    const lateRow = (await query('SELECT state,operator_resolution,operator_resolution_note FROM billing_checkout_intents WHERE id=$1', [dismissable.id])).rows[0];
    assert.strictEqual(lateRow.state, 'completed');
    assert(/later confirmed payment/.test(lateRow.operator_resolution_note), 'the dismissal is annotated so the record is not contradictory');
    assert.strictEqual(await audits(dismissable.id, 'billing.checkout.dismissed_then_paid'), 1, 'the late payment is audited');
    assert.strictEqual((await query('SELECT COUNT(*)::int n FROM subscriptions WHERE customer_id=$1', [dismissable.customerId])).rows[0].n >= 1, true, 'the late payment granted access');

    // Failure while recording a payment: before any effect the claim is released (retry possible);
    // after an effect it is kept so the checkout is never recorded twice.
    const early = await makeIntent('early', { ageDays: 9 });
    const partial = await makeIntent('partial', { ageDays: 9 });
    const realSettle = plisioModule.settleAttested;
    try {
      plisioModule.settleAttested = async () => { throw new Error('simulated failure before any effect'); };
      const r1 = await post(early.id, 'mark-paid', { reason: 'Plisio dashboard shows the invoice completed', confirm: 'PAID' });
      assert(r1.location.includes('error=') && /simulated failure/.test(r1.location), 'the failure is reported');
      assert.strictEqual((await query('SELECT operator_resolution FROM billing_checkout_intents WHERE id=$1', [early.id])).rows[0].operator_resolution, null, 'a failure before any effect releases the claim so it can be retried');
      assert(await inQueue(early.id), 'and the checkout is still in the queue');
      plisioModule.settleAttested = async intent => {
        await query(`INSERT INTO payment_history_transactions(provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,gross_amount_minor,fee_amount_minor,net_amount_minor,customer_id,metadata) VALUES('plisio',$1,'payment','completed',NOW(),'GBP',1000,0,1000,$2,'{}'::jsonb)`, [intent.provider_checkout_id, intent.customer_id]);
        throw new Error('simulated failure after the ledger entry');
      };
      const r2 = await post(partial.id, 'mark-paid', { reason: 'Plisio dashboard shows the invoice completed', confirm: 'PAID' });
      assert(/only partly recorded/.test(r2.location), `a partial failure must be explained (${r2.location})`);
      assert.strictEqual((await query('SELECT operator_resolution FROM billing_checkout_intents WHERE id=$1', [partial.id])).rows[0].operator_resolution, 'marked_paid', 'a partly applied payment keeps its claim');
      assert(!await inQueue(partial.id), 'so it does not reappear as unpaid');
      assert.strictEqual(await audits(partial.id, 'billing.checkout.mark_paid_failed'), 1, 'the failure is audited');
    } finally { plisioModule.settleAttested = realSettle; }

    // More than the first page: the panel can show everything.
    const many = [];
    for (let i = 0; i < 12; i += 1) many.push(await makeIntent(`many${i}`, { ageDays: 8 }));
    const pageHtml = await (await fetch(`${base}/admin/commerce/orders`, { headers: { cookie: j.get() } })).text();
    assert(pageHtml.includes('issues=all'), 'a backlog beyond the first page offers Show all');
    const allHtml = await (await fetch(`${base}/admin/commerce/orders?issues=all`, { headers: { cookie: j.get() } })).text();
    for (const item of many) assert(allHtml.includes(`/admin/billing/checkouts/${item.id}/mark-paid`), 'Show all reaches every unresolved checkout');

    // Record as paid: grants access, completes the checkout, writes an operator-attested ledger row.
    const paid = await post(old.id, 'mark-paid', { reason: 'Plisio dashboard shows the invoice completed', confirm: 'PAID' });
    assert(paid.location.includes('message='), `recording a payment must succeed (${paid.location})`);
    const intent = (await query('SELECT state,operator_resolution,operator_resolved_by FROM billing_checkout_intents WHERE id=$1', [old.id])).rows[0];
    assert.strictEqual(intent.state, 'completed', 'the checkout completes');
    assert.strictEqual(intent.operator_resolution, 'marked_paid');
    assert.strictEqual(intent.operator_resolved_by, adminId);
    assert((await query(`SELECT COUNT(*)::int n FROM subscriptions WHERE customer_id=$1 AND plan_id=$2`, [old.customerId, old.planId])).rows[0].n >= 1, 'access is granted through the normal activation path');
    const ledger = (await query(`SELECT gross_amount_minor,metadata FROM payment_history_transactions WHERE provider='plisio' AND provider_transaction_id=$1`, [`QUEUE-old-${suffix}`])).rows[0];
    assert(ledger, 'a ledger entry is written');
    assert.strictEqual(Number(ledger.gross_amount_minor), 1000, 'it records exactly the stored checkout amount');
    assert.strictEqual(ledger.metadata.operatorAttested, true, 'it is marked operator-confirmed');
    assert.notStrictEqual(ledger.metadata.providerVerified, true, 'it is never presented as provider-verified');
    assert.strictEqual(await audits(old.id, 'billing.checkout.mark_paid'), 1, 'the decision is audited');
    assert(!await inQueue(old.id), 'a settled checkout leaves the queue');
    assert(/already/.test((await post(old.id, 'mark-paid', { reason: 'Plisio dashboard shows the invoice completed', confirm: 'PAID' })).location), 'it cannot be recorded twice');
    assert.strictEqual((await query(`SELECT COUNT(*)::int n FROM payment_history_transactions WHERE provider='plisio' AND provider_transaction_id=$1`, [`QUEUE-old-${suffix}`])).rows[0].n, 1, 'exactly one ledger entry exists');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

async function cleanup() {
  await query(`DELETE FROM payment_history_transactions WHERE provider='plisio' AND provider_transaction_id LIKE $1`, [`QUEUE-%-${suffix}`]).catch(() => {});
  await query('DELETE FROM subscriptions WHERE customer_id=ANY($1::uuid[])', [customers]).catch(() => {});
  await query('DELETE FROM billing_checkout_intents WHERE id=ANY($1::uuid[])', [intentIds]).catch(() => {});
  await query('DELETE FROM plans WHERE id=ANY($1::uuid[])', [plans]).catch(() => {});
  await query('DELETE FROM customers WHERE id=ANY($1::uuid[])', [customers]).catch(() => {});
  await query('DELETE FROM jellyfin_servers WHERE id=$1', [serverId]).catch(() => {});
  await query('DELETE FROM auth_sessions WHERE user_id=$1', [adminId]).catch(() => {});
  await query('DELETE FROM app_users WHERE id=$1', [adminId]).catch(() => {});
  if (previousPlatform) await query(`UPDATE platform_settings SET setting_value=$1::jsonb,updated_at=NOW() WHERE setting_key='platform'`, [JSON.stringify(previousPlatform)]).catch(() => {});
  else await query(`DELETE FROM platform_settings WHERE setting_key='platform'`).catch(() => {});
  await runtimeSettings.reload().catch(() => {});
}

main()
  .then(() => console.log('checkout exception queue DB smoke: ok'))
  .catch(error => { console.error(error.stack || error); process.exitCode = 1; })
  .finally(async () => { await cleanup(); await getPool().end().catch(() => {}); process.exit(process.exitCode || 0); });
