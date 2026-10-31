'use strict';

// Regression: the header "New" / "Inbox" badges never cleared. Dates carry milliseconds but
// database timestamps carry microseconds, so after acknowledging an area the newest item stayed a
// fraction of a millisecond newer than the stored watermark and remained unread.
//
// The fix carries lossless microsecond watermarks from the database to the browser and back. This
// test proves, through the real snapshot and cursor code, that acknowledging an area clears
// exactly what was shown and not an item created after it, even inside the same millisecond.

require('dotenv').config();
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('operator read cursor precision DB smoke')) process.exit(0);

const assert = require('assert');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, getPool } = require('../src/db');
const readCursors = require('../src/platform/operator-read-cursors');
const operatorState = require('../src/platform/admin-operator-state');
const customerFilters = require('../src/platform/customer-filters');
const customersList = require('../src/platform/admin-customers-list');
const adminOrders = require('../src/platform/admin-orders');

const suffix = crypto.randomBytes(5).toString('hex');
let adminId = null;
const customers = [];
const tickets = [];
const subscriptions = [];
let planId = null;

// Far enough in the future to be the newest row in any database, so other data cannot interfere.
const FUTURE = "date_trunc('second',NOW())+INTERVAL '2 hours'";

async function makeCustomer(microseconds) {
  const row = await query(
    `INSERT INTO customers(display_name,email,created_at) VALUES($1,$2,${FUTURE}+($3||' microseconds')::interval) RETURNING id`,
    [`Cursor ${suffix} ${microseconds}`, `cursor-${suffix}-${microseconds}@example.invalid`, String(microseconds)]
  );
  customers.push(row.rows[0].id);
  return row.rows[0].id;
}

async function makeTicket(customerId, microseconds) {
  const row = await query(
    `INSERT INTO support_tickets(customer_id,subject,status,created_at) VALUES($1,$2,'open',${FUTURE}+($3||' microseconds')::interval) RETURNING id`,
    [customerId, `Cursor ticket ${suffix}`, String(microseconds)]
  );
  tickets.push(row.rows[0].id);
  return row.rows[0].id;
}

async function exactOf(table, id) {
  return (await query(`SELECT ${readCursors.exactSql('created_at')} AS exact FROM ${table} WHERE id=$1`, [id])).rows[0].exact;
}

(async () => {
  adminId = (await query(
    `INSERT INTO app_users(username,email,password_hash,role,active,legacy_numeric_id,is_owner,password_changed_at,email_verified_at)
     VALUES($1,$2,$3,'admin',TRUE,$4,FALSE,NOW(),NOW()) RETURNING id`,
    [`cursor-${suffix}`, `cursor-${suffix}@example.invalid`, await bcrypt.hash(`Cursor-${suffix}-Pw!9`, 4), 900000 + Math.floor(Math.random() * 90000)]
  )).rows[0].id;

  // --- Customers: first item shown, then a second created in the SAME millisecond after the page was rendered.
  const first = await makeCustomer(123456);
  const firstExact = await exactOf('customers', first);
  assert(readCursors.EXACT_WATERMARK.test(firstExact), `the database must produce a microsecond watermark (${firstExact})`);

  let snapshot = await operatorState.snapshot(adminId);
  assert.strictEqual(snapshot.counts.customers, 1, 'the new customer counts as unread');
  assert.strictEqual(snapshot.updatedExact.customers, firstExact, 'the snapshot must expose the exact newest timestamp, not a millisecond approximation');

  // The server-rendered pages capture the same lossless value.
  assert.strictEqual(await readCursors.captureSeenThrough('customers'), firstExact, 'page captures must be lossless too');

  // The administrator opens Customers: the browser sends back exactly what the snapshot gave it.
  await readCursors.markSeen(adminId, 'customers', snapshot.updatedExact.customers);
  snapshot = await operatorState.snapshot(adminId);
  assert.strictEqual(snapshot.counts.customers, 0, 'acknowledging the area must clear the newest item as well');

  // A customer created in the same millisecond, after the acknowledgement, must stay unread.
  const second = await makeCustomer(123900);
  snapshot = await operatorState.snapshot(adminId);
  assert.strictEqual(snapshot.counts.customers, 1, 'an item created within the same millisecond after the acknowledgement must stay unread');
  assert.strictEqual(snapshot.updatedExact.customers, await exactOf('customers', second));
  await readCursors.markSeen(adminId, 'customers', snapshot.updatedExact.customers);
  assert.strictEqual((await operatorState.snapshot(adminId)).counts.customers, 0, 'and clears once it has been seen');

  // The stored cursor is monotonic: an older acknowledgement never moves it back.
  await readCursors.markSeen(adminId, 'customers', firstExact);
  assert.strictEqual((await operatorState.snapshot(adminId)).counts.customers, 0, 'an older acknowledgement must not make seen items unread again');

  // --- Tickets use a different code path (the support module's own summary query).
  const owner = customers[0];
  const t1 = await makeTicket(owner, 223456);
  let ticketSnapshot = await operatorState.snapshot(adminId);
  assert.strictEqual(ticketSnapshot.counts.tickets >= 1, true);
  assert.strictEqual(ticketSnapshot.updatedExact.tickets, await exactOf('support_tickets', t1), 'tickets must expose the exact newest timestamp');
  await readCursors.markSeen(adminId, 'tickets', ticketSnapshot.updatedExact.tickets);
  const ticketsBefore = (await operatorState.snapshot(adminId)).counts.tickets;
  assert.strictEqual(ticketsBefore, 0, 'acknowledging Tickets must clear the newest ticket');
  await makeTicket(owner, 223900);
  assert.strictEqual((await operatorState.snapshot(adminId)).counts.tickets, 1, 'a ticket created in the same millisecond afterwards must stay unread');

  // --- Per-row "New" labels must use the same exact comparison as the header counts.
  // Two customers in the same millisecond; the watermark is the first one's exact time.
  const rows = (await customerFilters.listCustomers(customersList.parseFilters({}), null, { page: 1, pageSize: 100, sort: 'registered', dir: 'desc' })).rows;
  const rowFirst = rows.find(row => row.id === first), rowSecond = rows.find(row => row.id === second);
  assert(rowFirst && rowSecond, 'both customers must be in the list');
  assert.strictEqual(rowFirst.created_exact, firstExact, 'list rows must carry the exact creation time');
  assert.strictEqual(readCursors.isAfterWatermark(rowFirst.created_exact, rowFirst.created_at, firstExact), false, 'the item the administrator already saw must not be labelled New');
  assert.strictEqual(readCursors.isAfterWatermark(rowSecond.created_exact, rowSecond.created_at, firstExact), true, 'an item created in the same millisecond afterwards must be labelled New');

  // Orders: the rendered table carries one New pill, for the later purchase only.
  planId = (await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible,is_free_tier) VALUES($1,$2,'jellyfin','direct','month',30,999,'GBP',1,'premium',TRUE,TRUE,FALSE) RETURNING id`, [`cursor-${suffix}`, `Cursor plan ${suffix}`])).rows[0].id;
  const orderBuyerA = await makeCustomer(323456), orderBuyerB = await makeCustomer(323900);
  const subA = (await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,created_at) VALUES($1,$2,'active','stripe',NOW(),NOW()+INTERVAL '30 days',${FUTURE}+INTERVAL '323456 microseconds') RETURNING id`, [orderBuyerA, planId])).rows[0].id;
  const subB = (await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,created_at) VALUES($1,$2,'active','plisio',NOW(),NOW()+INTERVAL '30 days',${FUTURE}+INTERVAL '323900 microseconds') RETURNING id`, [orderBuyerB, planId])).rows[0].id;
  // A recent but cancelled purchase is not an unread order: it must neither count in the header
  // nor be labelled New in the table, even though the table lists it.
  const orderBuyerC = await makeCustomer(323950);
  const subC = (await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,created_at) VALUES($1,$2,'cancelled','plisio',NOW(),NOW()+INTERVAL '30 days',${FUTURE}+INTERVAL '323950 microseconds') RETURNING id`, [orderBuyerC, planId])).rows[0].id;
  subscriptions.push(subA, subB, subC);
  const orderRows = (await adminOrders.purchases({ page: 1, planId })).rows;
  const orderSeen = await exactOf('subscriptions', subA);
  const html = adminOrders.orderTable({ rows: orderRows, total: orderRows.length, page: 1, pages: 1 }, orderSeen);
  assert(orderRows.some(row => row.id === subC), 'the table lists the cancelled purchase');
  assert.strictEqual((html.match(/>New</g) || []).length, 1, 'only the eligible purchase created after the watermark is labelled New (not the cancelled one)');
  assert(html.includes('Plisio'), 'the Orders table lists the crypto purchase with its provider name');

  // The Orders header count uses the same eligible set as the table: a Plisio purchase counts, and
  // clears once acknowledged, while the same-millisecond purchase after the watermark stays unread.
  await readCursors.markSeen(adminId, 'orders', orderSeen);
  const ordersSnapshot = await operatorState.snapshot(adminId);
  assert.strictEqual(ordersSnapshot.counts.orders, 1, 'the later Plisio purchase counts toward the Orders badge');
  assert.strictEqual(ordersSnapshot.updatedExact.orders, await exactOf('subscriptions', subB), 'the Orders watermark follows the Plisio purchase');
  await readCursors.markSeen(adminId, 'orders', ordersSnapshot.updatedExact.orders);
  assert.strictEqual((await operatorState.snapshot(adminId)).counts.orders, 0, 'and clears once seen');

  // --- Legacy clients that still send a millisecond epoch keep working (rounded up so the newest item clears).
  await query('DELETE FROM admin_nav_read_state WHERE admin_user_id=$1', [adminId]);
  const legacy = await operatorState.snapshot(adminId);
  await readCursors.markSeen(adminId, 'customers', String(legacy.updatedAt.customers));
  assert.strictEqual((await operatorState.snapshot(adminId)).counts.customers, 0, 'a millisecond watermark from an older page must still clear the newest item');
})()
  .then(() => console.log('operator read cursor precision DB smoke: ok'))
  .catch(error => { console.error(error.stack || error); process.exitCode = 1; })
  .finally(async () => {
    await query('DELETE FROM admin_nav_read_state WHERE admin_user_id=$1', [adminId]).catch(() => {});
    await query('DELETE FROM support_tickets WHERE id=ANY($1::uuid[])', [tickets]).catch(() => {});
    await query('DELETE FROM subscriptions WHERE id=ANY($1::uuid[])', [subscriptions]).catch(() => {});
    if (planId) await query('DELETE FROM plans WHERE id=$1', [planId]).catch(() => {});
    await query('DELETE FROM customers WHERE id=ANY($1::uuid[])', [customers]).catch(() => {});
    await query('DELETE FROM app_users WHERE id=$1', [adminId]).catch(() => {});
    await getPool().end().catch(() => {});
    process.exit(process.exitCode || 0);
  });
