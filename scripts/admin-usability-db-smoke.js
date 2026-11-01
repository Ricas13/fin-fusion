'use strict';

// Regression coverage for the admin usability pass: crypto (Plisio) payments must be
// visible in Orders, unconfirmed crypto checkouts must be surfaced for follow-up, and the
// bulk "Extend by days" action must apply its days exactly once per item.

require('dotenv').config();
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('admin usability DB smoke')) process.exit(0);

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { query, getPool } = require('../src/db');
const orders = require('../src/platform/admin-orders');
const bulkJobs = require('../src/platform/bulk-jobs');
const bulkWorker = require('../src/jellyfin/bulk-worker');
require('../src/customers/operator-bulk-operations'); // registers extend_days

const suffix = crypto.randomBytes(4).toString('hex');
const created = { customers: [], plans: [] };

async function makePlan() {
  const row = await query(`
    INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible,is_free_tier)
    VALUES($1,$2,'jellyfin','direct','month',30,999,'GBP',1,'premium',TRUE,TRUE,FALSE) RETURNING id
  `, [`usability-${suffix}`, `Usability ${suffix}`]);
  created.plans.push(row.rows[0].id);
  return row.rows[0].id;
}

async function makeCustomer(label) {
  const row = await query('INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id',
    [`Usability ${label} ${suffix}`, `usability-${label}-${suffix}@example.invalid`]);
  created.customers.push(row.rows[0].id);
  return row.rows[0].id;
}

async function makeIntent(customerId, planId, state, createdAgo, label, { terminal = false } = {}) {
  await query(`
    INSERT INTO billing_checkout_intents(scope,customer_id,plan_id,provider,checkout_mode,state,nonce_hash,provider_checkout_id,expires_at,created_at,commercial_snapshot,provider_terminal_at)
    VALUES('customer',$1,$2,'plisio','payment',$3,$4,$5,NOW()+INTERVAL '1 day',NOW()-$6::interval,$7::jsonb,${terminal ? 'NOW()' : 'NULL'})
  `, [customerId, planId, state, `nonce-${label}-${suffix}`, `plisio-${label}-${suffix}`, createdAgo, JSON.stringify({ priceMinor: 999, currency: 'GBP' })]);
}

(async () => {
  const planId = await makePlan();

  // Plisio purchases are listed and filterable.
  const buyer = await makeCustomer('buyer');
  await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','plisio',NOW(),NOW()+INTERVAL '30 days')`, [buyer, planId]);
  const listed = await orders.purchases({ page: 1, provider: 'plisio', q: `Usability buyer ${suffix}` });
  assert.strictEqual(listed.total, 1, 'Orders must list Plisio purchases');
  assert.strictEqual(listed.rows[0].source, 'plisio');
  assert.strictEqual(orders.providerLabel('plisio'), 'Plisio');
  assert.strictEqual(orders.parsePurchaseFilters({ orderProvider: 'plisio' }, { from: '', to: '' }).provider, 'plisio', 'the provider filter must accept Plisio');

  // Only stale, unsettled crypto checkouts need follow-up.
  const stale = await makeCustomer('stale'), fresh = await makeCustomer('fresh'), done = await makeCustomer('done'), abandoned = await makeCustomer('abandoned'), inWindow = await makeCustomer('inwindow'), failed = await makeCustomer('failed'), failedNow = await makeCustomer('failednow'), localExpired = await makeCustomer('localexpired'), expiredClosed = await makeCustomer('expiredclosed');
  await makeIntent(stale, planId, 'open', '5 hours', 'stale');
  await makeIntent(inWindow, planId, 'open', '2 hours', 'inwindow');
  await makeIntent(failed, planId, 'failed', '1 hour', 'failed');
  // A failure is actionable immediately, not only after 30 minutes.
  await makeIntent(failedNow, planId, 'failed', '5 minutes', 'failednow');
  // The worker still investigates locally expired checkouts the provider has not closed; those must not vanish.
  await makeIntent(localExpired, planId, 'expired', '5 hours', 'localexpired');
  await makeIntent(expiredClosed, planId, 'expired', '5 hours', 'expiredclosed', { terminal: true });
  await makeIntent(fresh, planId, 'open', '5 minutes', 'fresh');
  await makeIntent(done, planId, 'completed', '2 hours', 'done');
  await makeIntent(abandoned, planId, 'open', '2 hours', 'abandoned', { terminal: true });
  const issues = (await orders.checkoutIssues()).filter(row => created.customers.includes(row.customer_id));
  assert.deepStrictEqual(issues.map(row => row.customer_id).sort(), [stale, failed, failedNow, localExpired].sort(), 'only failed checkouts, and open / locally expired / cancelled ones past their payment window that Plisio has not closed, must be surfaced (not fresh, still-payable, completed or provider-closed ones)');
  assert.strictEqual(issues[0].kind, 'checkout');
  assert.strictEqual(Number(issues.find(row => row.customer_id === stale).amount_minor), 999);
  assert.strictEqual(require('../src/payments/plisio').INVOICE_LIFETIME_MINUTES, 180, 'the Orders window follows the invoice lifetime used when invoices are created');

  // Bulk extend adds the days once, even if the item is processed again.
  const extendee = await makeCustomer('extendee');
  const sub = (await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','manual',NOW(),NOW()+INTERVAL '10 days') RETURNING id`, [extendee, planId])).rows[0];
  const job = await bulkJobs.createJob('extend_days', { days: 7, reason: 'usability smoke' });
  await bulkJobs.enqueueItems(job.job.id, [extendee]);
  await bulkWorker.processBatch();
  const item = (await query('SELECT id,status,last_error FROM background_job_items WHERE job_id=$1', [job.job.id])).rows[0];
  // A fixture database has no media server, so the closing reconciliation may legitimately
  // fail after the days were committed. The days must be applied either way, exactly once.
  assert(item.status === 'completed' || /Days were added, but service reconciliation/.test(String(item.last_error || '')), `bulk extend must apply its days (${item.status}: ${item.last_error})`);
  const after = (await query('SELECT service_extension_days FROM subscriptions WHERE id=$1', [sub.id])).rows[0];
  assert.strictEqual(Number(after.service_extension_days), 7, 'bulk extend must add the requested days');
  const events = await query(`SELECT COUNT(*)::int n FROM subscription_service_extension_events WHERE subscription_id=$1 AND source='admin_bulk'`, [sub.id]);
  assert.strictEqual(events.rows[0].n, 1, 'one extension event per item');
  const audited = await query(`SELECT 1 FROM audit_log WHERE action='admin.bulk.extend_days' AND entity_id=$1::text`, [extendee]);
  assert.strictEqual(audited.rowCount, 1, 'bulk extend must be audited');

  // Replaying the same item (a worker retry) must not add days or write a second audit row.
  await query(`UPDATE background_job_items SET status='pending',last_error=NULL WHERE id=$1`, [item.id]);
  await bulkWorker.processBatch();
  const replayed = (await query('SELECT status,last_error FROM background_job_items WHERE id=$1', [item.id])).rows[0];
  assert(replayed.status === 'completed' || /Days were added, but service reconciliation/.test(String(replayed.last_error || '')), `replay must be accepted (${replayed.status}: ${replayed.last_error})`);
  assert.strictEqual(Number((await query('SELECT service_extension_days FROM subscriptions WHERE id=$1', [sub.id])).rows[0].service_extension_days), 7, 'a replay must not add the days again');
  assert.strictEqual((await query(`SELECT 1 FROM audit_log WHERE action='admin.bulk.extend_days' AND entity_id=$1::text`, [extendee])).rowCount, 1, 'a replay must not write a second audit row');

  // A replay that lands exactly on the cap is "already applied", not a cap failure; a fresh item over the cap fails with nothing changed.
  const capped = await makeCustomer('capped');
  const capSub = (await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,service_extension_days) VALUES($1,$2,'active','manual',NOW(),NOW()+INTERVAL '10 days',3643) RETURNING id`, [capped, planId])).rows[0];
  const capJob = await bulkJobs.createJob('extend_days', { days: 7, reason: 'usability smoke' });
  await bulkJobs.enqueueItems(capJob.job.id, [capped]);
  await bulkWorker.processBatch();
  const capItem = (await query('SELECT id,status,last_error FROM background_job_items WHERE job_id=$1', [capJob.job.id])).rows[0];
  assert(capItem.status === 'completed' || /Days were added/.test(String(capItem.last_error || '')), `reaching the cap exactly must succeed (${capItem.status}: ${capItem.last_error})`);
  assert.strictEqual(Number((await query('SELECT service_extension_days FROM subscriptions WHERE id=$1', [capSub.id])).rows[0].service_extension_days), 3650);
  await query(`UPDATE background_job_items SET status='pending',last_error=NULL WHERE id=$1`, [capItem.id]);
  await bulkWorker.processBatch();
  const capReplay = (await query('SELECT status,last_error FROM background_job_items WHERE id=$1', [capItem.id])).rows[0];
  assert(!/safety limit/.test(String(capReplay.last_error || '')), 'a replay at the cap must report already applied, not a cap failure');
  const overJob = await bulkJobs.createJob('extend_days', { days: 7, reason: 'usability smoke' });
  await bulkJobs.enqueueItems(overJob.job.id, [capped]);
  await bulkWorker.processBatch();
  const overItem = (await query('SELECT status,last_error FROM background_job_items WHERE job_id=$1', [overJob.job.id])).rows[0];
  assert.strictEqual(overItem.status, 'failed');
  assert(/safety limit/.test(overItem.last_error), 'a new item over the cap must fail');
  assert.strictEqual(Number((await query('SELECT service_extension_days FROM subscriptions WHERE id=$1', [capSub.id])).rows[0].service_extension_days), 3650, 'a rejected item must change nothing');
  assert.strictEqual((await query(`SELECT 1 FROM subscription_service_extension_events WHERE subscription_id=$1 AND source='admin_bulk' AND reference_id LIKE $2`, [capSub.id, `bulk:${overJob.job.id}:%`])).rowCount, 0, 'a rejected item must not leave an event behind');

  // The re-check route records the attempt before contacting the provider and never swallows the audit failure.
  const billingSource = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'platform', 'admin-billing.js'), 'utf8');
  const routeStart = billingSource.indexOf("router.post('/admin/billing/checkouts/:id/recheck'");
  const route = billingSource.slice(routeStart, billingSource.indexOf('// Close a crypto checkout automation'));
  assert(route.indexOf("'billing.checkout.recheck'") > 0 && route.indexOf("'billing.checkout.recheck'") < route.indexOf('providerCheckoutRecovery.run'), 'the attempt must be audited before the provider is contacted');
  assert(!/audit_log[^;]*\)\.catch\(/.test(route), 'a failed audit write must not be swallowed');
  assert(route.indexOf("target.provider !== 'plisio'") > 0 && route.indexOf("target.provider !== 'plisio'") < route.indexOf("'billing.checkout.recheck'"), 'only Plisio checkouts may be re-checked, decided before anything is audited or contacted');
})()
  .then(() => console.log('admin usability DB smoke: ok'))
  .catch(error => { console.error(error.stack || error); process.exitCode = 1; })
  .finally(async () => {
    await query(`DELETE FROM background_jobs WHERE job_type='extend_days' AND params->>'reason'='usability smoke'`).catch(() => {});
    await query('DELETE FROM billing_checkout_intents WHERE customer_id=ANY($1::uuid[])', [created.customers]).catch(() => {});
    await query('DELETE FROM subscriptions WHERE customer_id=ANY($1::uuid[])', [created.customers]).catch(() => {});
    await query('DELETE FROM customers WHERE id=ANY($1::uuid[])', [created.customers]).catch(() => {});
    await query('DELETE FROM plans WHERE id=ANY($1::uuid[])', [created.plans]).catch(() => {});
    await getPool().end().catch(() => {});
    process.exit(process.exitCode || 0);
  });
