'use strict';

// Regression: the header "New" / "Inbox" badges never cleared. Dates carry milliseconds but
// database timestamps carry microseconds, so after acknowledging an area the newest item was
// still a fraction of a millisecond newer than the stored watermark and stayed unread.

require('dotenv').config();
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('operator read cursor precision DB smoke')) process.exit(0);

const assert = require('assert');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, getPool } = require('../src/db');
const readCursors = require('../src/platform/operator-read-cursors');

const suffix = crypto.randomBytes(5).toString('hex');
let adminId = null;
let customerId = null;

async function unread(adminUserId) {
  const seen = await readCursors.list(adminUserId);
  const row = await query(
    `SELECT COUNT(*)::int n,MAX(created_at) updated FROM customers
      WHERE id=$2 AND created_at>NOW()-INTERVAL '7 days' AND ($1::timestamptz IS NULL OR created_at>$1::timestamptz)`,
    [seen.customers || null, customerId]
  );
  return row.rows[0];
}

(async () => {
  adminId = (await query(
    `INSERT INTO app_users(username,email,password_hash,role,active,legacy_numeric_id,is_owner,password_changed_at,email_verified_at)
     VALUES($1,$2,$3,'admin',TRUE,$4,FALSE,NOW(),NOW()) RETURNING id`,
    [`cursor-${suffix}`, `cursor-${suffix}@example.invalid`, await bcrypt.hash(`Cursor-${suffix}-Pw!9`, 4), 900000 + Math.floor(Math.random() * 90000)]
  )).rows[0].id;

  // A creation time with a sub-millisecond fraction (…123456 microseconds).
  customerId = (await query(
    `INSERT INTO customers(display_name,email,created_at) VALUES($1,$2,date_trunc('second',NOW())-INTERVAL '1 minute'+INTERVAL '123456 microseconds') RETURNING id`,
    [`Cursor ${suffix}`, `cursor-${suffix}@example.invalid`]
  )).rows[0].id;

  const before = await unread(adminId);
  assert.strictEqual(before.n, 1, 'a new customer must count as unread');

  // Exactly what the browser sends: the newest item's time as a millisecond epoch.
  await readCursors.markSeen(adminId, 'customers', String(new Date(before.updated).getTime()));

  const after = await unread(adminId);
  assert.strictEqual(after.n, 0, 'acknowledging the area must clear the newest item as well');

  // A customer created after the acknowledgement is still unread.
  const later = (await query(`INSERT INTO customers(display_name,email,created_at) VALUES($1,$2,NOW()) RETURNING id`, [`Cursor later ${suffix}`, `cursor-later-${suffix}@example.invalid`])).rows[0].id;
  const seen = await readCursors.list(adminId);
  const fresh = await query('SELECT COUNT(*)::int n FROM customers WHERE id=$1 AND created_at>$2::timestamptz', [later, seen.customers]);
  assert.strictEqual(fresh.rows[0].n, 1, 'items created after the acknowledgement must stay unread');
  await query('DELETE FROM customers WHERE id=$1', [later]);
})()
  .then(() => console.log('operator read cursor precision DB smoke: ok'))
  .catch(error => { console.error(error.stack || error); process.exitCode = 1; })
  .finally(async () => {
    await query('DELETE FROM admin_nav_read_state WHERE admin_user_id=$1', [adminId]).catch(() => {});
    await query('DELETE FROM customers WHERE id=$1', [customerId]).catch(() => {});
    await query('DELETE FROM app_users WHERE id=$1', [adminId]).catch(() => {});
    await getPool().end().catch(() => {});
    process.exit(process.exitCode || 0);
  });
