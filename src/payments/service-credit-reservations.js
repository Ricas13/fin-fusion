'use strict';

const { query, transaction } = require('../db');
const planPricing = require('./plan-pricing');
const accounting = require('./service-credit-accounting');

function cleanCurrency(value) { return planPricing.cleanCurrency(value, 'GBP'); }
function int(value) { const n = Number(value); return Number.isInteger(n) ? n : 0; }
function conflict(message) {
  const error = new Error(message);
  error.code = 'SERVICE_CREDIT_LATE_SETTLEMENT_CONFLICT';
  return error;
}

async function availableMinorForClient(client, customerId, currency) {
  return accounting.rawAvailableMinorForClient(client, customerId, cleanCurrency(currency));
}

async function availableMinor(customerId, currency) {
  return transaction(client => availableMinorForClient(client, customerId, currency));
}

async function reserveForIntent({ customerId, checkoutIntentId, currency, maxAmountMinor, expiresAt }) {
  const wanted = cleanCurrency(currency), maximum = Math.max(0, int(maxAmountMinor));
  if (!checkoutIntentId || maximum <= 0) return { amountMinor: 0, currency: wanted, reserved: false };
  return transaction(async client => {
    await accounting.lockCustomer(client, customerId);
    await accounting.ensureHistoricalAllocations(client, customerId, wanted);
    const intent = (await client.query(
      'SELECT id,customer_id,state FROM billing_checkout_intents WHERE id=$1 FOR UPDATE',
      [checkoutIntentId]
    )).rows[0];
    if (!intent || String(intent.customer_id) !== String(customerId) || intent.state !== 'open') {
      throw new Error('Checkout intent is not available for service credit.');
    }
    const existing = (await client.query(
      'SELECT * FROM affiliate_credit_checkout_reservations WHERE checkout_intent_id=$1',
      [checkoutIntentId]
    )).rows[0];
    if (existing) return { amountMinor: int(existing.amount_minor), currency: existing.currency, reserved: existing.state === 'reserved' };
    const available = await availableMinorForClient(client, customerId, wanted), amount = Math.min(available, maximum);
    if (amount <= 0) return { amountMinor: 0, currency: wanted, reserved: false };
    const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt || Date.now() + 60 * 60 * 1000);
    const saved = (await client.query(`
      INSERT INTO affiliate_credit_checkout_reservations(customer_id,checkout_intent_id,currency,amount_minor,expires_at)
      VALUES($1,$2,$3,$4,$5) RETURNING *
    `, [customerId, checkoutIntentId, wanted, amount, expiry])).rows[0];
    await client.query(`
      INSERT INTO audit_log(action,entity_type,entity_id,metadata)
      VALUES('affiliate.credit.reserve','checkout_intent',$1,$2::jsonb)
    `, [String(checkoutIntentId), JSON.stringify({ customerId, currency: wanted, amountMinor: amount, expiresAt: expiry.toISOString() })]);
    return { amountMinor: amount, currency: wanted, reserved: true, id: saved.id };
  });
}

async function settle(client, checkoutIntentId, state) {
  if (!checkoutIntentId) return null;
  const candidate = (await client.query(
    'SELECT * FROM affiliate_credit_checkout_reservations WHERE checkout_intent_id=$1',
    [checkoutIntentId]
  )).rows[0];
  if (!candidate) return null;
  if (candidate.state === 'applied') return candidate;

  if (state === 'cancelled_attached' || state === 'expired') return candidate;

  if (['cancelled', 'failed'].includes(state)) {
    if (candidate.state !== 'reserved') return candidate;
    const row = (await client.query(`
      UPDATE affiliate_credit_checkout_reservations
      SET state='released',released_at=COALESCE(released_at,NOW()),updated_at=NOW()
      WHERE id=$1 AND state='reserved' RETURNING *
    `, [candidate.id])).rows[0] || candidate;
    await client.query(`
      INSERT INTO audit_log(action,entity_type,entity_id,metadata)
      VALUES('affiliate.credit.release','checkout_intent',$1,$2::jsonb)
    `, [String(checkoutIntentId), JSON.stringify({ customerId: row.customer_id, currency: row.currency, amountMinor: int(row.amount_minor), reason: state })]);
    return row;
  }

  if (state !== 'completed') return candidate;

  await accounting.lockCustomer(client, candidate.customer_id);
  let row = (await client.query(
    'SELECT * FROM affiliate_credit_checkout_reservations WHERE id=$1 FOR UPDATE',
    [candidate.id]
  )).rows[0];
  if (!row || row.state === 'applied') return row || null;

  await accounting.ensureHistoricalAllocations(client, row.customer_id, row.currency);
  const expired = new Date(row.expires_at).getTime() <= Date.now();
  if (row.state === 'released' || expired) {
    const available = await accounting.rawAvailableMinorForClient(client, row.customer_id, row.currency);
    if (available < int(row.amount_minor)) {
      throw conflict(`Paid provider checkout ${checkoutIntentId} settled after its service-credit reservation was released or expired, but only ${available} ${row.currency} minor units remain spendable for the reserved ${int(row.amount_minor)}.`);
    }
  } else if (row.state !== 'reserved') {
    throw conflict(`Service-credit reservation ${row.id} is in unexpected state ${row.state}.`);
  }

  const referenceId = `mixed-checkout:${checkoutIntentId}`;
  let debit = (await client.query(`
    INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,reference_id,note,metadata)
    VALUES($1,$2,$3,'redeemed','available',$4,$5,$6::jsonb)
    ON CONFLICT(entry_type,reference_id) DO NOTHING RETURNING *
  `, [row.customer_id, row.currency, -int(row.amount_minor), referenceId, 'Applied service credit to provider checkout', JSON.stringify({ checkoutIntentId: String(checkoutIntentId), reservationId: row.id })])).rows[0];
  if (!debit) {
    debit = (await client.query(
      'SELECT * FROM affiliate_credit_ledger WHERE entry_type=\'redeemed\' AND reference_id=$1 LIMIT 1',
      [referenceId]
    )).rows[0];
  }
  if (!debit || String(debit.customer_id) !== String(row.customer_id) || String(debit.currency) !== String(row.currency) || int(debit.amount_minor) !== -int(row.amount_minor)) {
    throw conflict(`Existing service-credit debit for checkout ${checkoutIntentId} does not match its reservation.`);
  }
  await accounting.allocateOneDebit(client, debit);
  row = (await client.query(`
    UPDATE affiliate_credit_checkout_reservations
    SET state='applied',applied_at=COALESCE(applied_at,NOW()),updated_at=NOW()
    WHERE id=$1 RETURNING *
  `, [row.id])).rows[0];
  await client.query(`
    INSERT INTO audit_log(action,entity_type,entity_id,metadata)
    VALUES('affiliate.credit.apply','checkout_intent',$1,$2::jsonb)
  `, [String(checkoutIntentId), JSON.stringify({ customerId: row.customer_id, currency: row.currency, amountMinor: int(row.amount_minor), lateSettlement: expired || candidate.state === 'released' })]);
  return row;
}

async function reservationForIntent(checkoutIntentId) {
  const r = await query('SELECT * FROM affiliate_credit_checkout_reservations WHERE checkout_intent_id=$1', [checkoutIntentId]);
  return r.rows[0] || null;
}

module.exports = { availableMinorForClient, availableMinor, reserveForIntent, settle, reservationForIntent, cleanCurrency };
