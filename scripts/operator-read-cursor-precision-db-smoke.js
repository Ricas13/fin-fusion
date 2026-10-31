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

const suffix = crypto.randomBytes(5).toString('hex');
let adminId = null;
const customers = [];
const tickets = [];

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
    await query('DELETE FROM customers WHERE id=ANY($1::uuid[])', [customers]).catch(() => {});
    await query('DELETE FROM app_users WHERE id=$1', [adminId]).catch(() => {});
    await getPool().end().catch(() => {});
    process.exit(process.exitCode || 0);
  });
