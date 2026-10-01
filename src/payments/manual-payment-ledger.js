'use strict';

const { query, transaction } = require('../db');

const METHOD_LABELS = Object.freeze({
  cash: 'Cash',
  bank_transfer: 'Bank transfer',
  crypto: 'Crypto',
  other: 'Other'
});
const CURRENCIES = Object.freeze(['GBP', 'USD', 'EUR']);

function cleanAmountMinor(raw) {
  const value = Number.parseFloat(String(raw || '').replace(/,/g, ''));
  if (!Number.isFinite(value) || value <= 0) throw new Error('Enter an amount greater than zero.');
  const minor = Math.round(value * 100);
  if (minor > 100000000) throw new Error('Amount is too large.');
  return minor;
}

function cleanCurrency(raw) {
  const value = String(raw || '').trim().toUpperCase();
  if (!CURRENCIES.includes(value)) throw new Error('Choose a valid currency.');
  return value;
}

function cleanMethod(raw) {
  const value = String(raw || '').trim();
  if (!Object.prototype.hasOwnProperty.call(METHOD_LABELS, value)) throw new Error('Choose a valid payment method.');
  return value;
}

async function list(customerId) {
  const result = await query(`
    SELECT mpe.id,mpe.amount_minor,mpe.currency,mpe.method,mpe.note,mpe.created_at,
           COALESCE(u.username,'—') AS recorded_by_username
    FROM manual_payment_events mpe
    LEFT JOIN app_users u ON u.id=mpe.recorded_by
    WHERE mpe.customer_id=$1
    ORDER BY mpe.created_at DESC
    LIMIT 100
  `, [customerId]);
  return result.rows;
}

async function record({ customerId, amount, currency, method, note = '', actorUserId = null }) {
  const amountMinor = cleanAmountMinor(amount);
  const normalizedCurrency = cleanCurrency(currency);
  const normalizedMethod = cleanMethod(method);
  const normalizedNote = String(note || '').trim().slice(0, 500);

  return transaction(async client => {
    const customer = await client.query('SELECT id FROM customers WHERE id=$1 FOR SHARE', [customerId]);
    if (!customer.rowCount) throw new Error('Customer not found.');

    const inserted = await client.query(`
      INSERT INTO manual_payment_events(customer_id,amount_minor,currency,method,note,recorded_by)
      VALUES($1,$2,$3,$4,$5,$6)
      RETURNING *
    `, [customerId, amountMinor, normalizedCurrency, normalizedMethod, normalizedNote, actorUserId]);

    await client.query(`
      INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'admin.customer.manual_payment.recorded','customer',$2,$3::jsonb)
    `, [actorUserId, customerId, JSON.stringify({
      manualPaymentEventId: inserted.rows[0].id,
      amountMinor,
      currency: normalizedCurrency,
      method: normalizedMethod
    })]);

    return inserted.rows[0];
  });
}

module.exports = {
  METHOD_LABELS,
  CURRENCIES,
  cleanAmountMinor,
  cleanCurrency,
  cleanMethod,
  list,
  record
};
