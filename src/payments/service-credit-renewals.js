'use strict';

const { query, transaction } = require('../db');
const accounting = require('./service-credit-accounting');
const planPricing = require('./plan-pricing');

function cleanCurrency(value) { return planPricing.cleanCurrency(value, 'GBP'); }
function int(value) { const n = Number(value); return Number.isInteger(n) ? n : 0; }
function identityConflict(message) {
  const error = new Error(message);
  error.code = 'SERVICE_CREDIT_RENEWAL_IDENTITY_CONFLICT';
  return error;
}
function rowResult(row) { return row ? {
  id: row.id,
  customerId: row.customer_id,
  subscriptionId: row.subscription_id,
  provider: row.provider,
  providerInvoiceId: row.provider_invoice_id,
  providerAdjustmentId: row.provider_adjustment_id || null,
  currency: row.currency,
  amountMinor: int(row.amount_minor),
  state: row.state
} : null; }

async function reservationForStripeInvoice(providerInvoiceId) {
  if (!providerInvoiceId) return null;
  const r = await query(`SELECT * FROM affiliate_credit_renewal_reservations WHERE provider='stripe' AND provider_invoice_id=$1 LIMIT 1`, [String(providerInvoiceId)]);
  return rowResult(r.rows[0]);
}

async function reserveStripeInvoice({ providerInvoiceId, providerSubscriptionId, currency, maxAmountMinor }) {
  const invoiceId = String(providerInvoiceId || '').trim(), providerSubId = String(providerSubscriptionId || '').trim(), requested = String(currency || '').trim().toUpperCase(), maximum = Math.max(0, int(maxAmountMinor));
  if (!planPricing.CURRENCIES.includes(requested)) return { reserved: false, amountMinor: 0, currency: requested || null, reason: 'unsupported_currency' };
  const wanted = requested;
  if (!invoiceId || !providerSubId) return { reserved: false, amountMinor: 0, currency: wanted, reason: 'not_applicable' };
  return transaction(async client => {
    const sub = (await client.query(`SELECT id,customer_id FROM subscriptions WHERE source='stripe' AND provider_subscription_id=$1 ORDER BY created_at DESC LIMIT 1`, [providerSubId])).rows[0];
    if (!sub) return { reserved: false, amountMinor: 0, currency: wanted, reason: 'subscription_not_found' };
    await accounting.lockCustomer(client, sub.customer_id);
    const current = (await client.query(`SELECT id,customer_id FROM subscriptions WHERE id=$1 AND customer_id=$2 AND source='stripe' AND provider_subscription_id=$3`, [sub.id, sub.customer_id, providerSubId])).rows[0];
    if (!current) return { reserved: false, amountMinor: 0, currency: wanted, reason: 'subscription_changed' };

    const existing = (await client.query(`SELECT * FROM affiliate_credit_renewal_reservations WHERE provider='stripe' AND provider_invoice_id=$1 FOR UPDATE`, [invoiceId])).rows[0];
    if (existing) {
      if (String(existing.customer_id) !== String(sub.customer_id) || String(existing.subscription_id) !== String(sub.id) || String(existing.currency).trim() !== wanted) {
        throw identityConflict(`Stripe invoice ${invoiceId} was replayed with a different subscription, customer, or currency than its service-credit reservation.`);
      }
      return { ...rowResult(existing), reserved: ['reserved', 'provider_applied'].includes(existing.state) };
    }

    if (maximum <= 0) return { reserved: false, amountMinor: 0, currency: wanted, customerId: sub.customer_id, subscriptionId: sub.id, reason: 'not_applicable' };
    await client.query(`UPDATE affiliate_credit_ledger SET state='available' WHERE customer_id=$1 AND state='pending' AND available_at IS NOT NULL AND available_at<=NOW()`, [sub.customer_id]);
    await accounting.ensureHistoricalAllocations(client, sub.customer_id, wanted);
    const available = await accounting.rawAvailableMinorForClient(client, sub.customer_id, wanted), amount = Math.min(available, maximum);
    if (amount <= 0) return { reserved: false, amountMinor: 0, currency: wanted, customerId: sub.customer_id, subscriptionId: sub.id, reason: 'no_available_credit' };
    const saved = (await client.query(`INSERT INTO affiliate_credit_renewal_reservations(customer_id,subscription_id,provider,provider_invoice_id,currency,amount_minor) VALUES($1,$2,'stripe',$3,$4,$5) RETURNING *`, [sub.customer_id, sub.id, invoiceId, wanted, amount])).rows[0];
    await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('affiliate.credit.renewal.reserve','subscription',$1,$2::jsonb)`, [String(sub.id), JSON.stringify({ customerId: sub.customer_id, provider: 'stripe', providerSubscriptionId: providerSubId, providerInvoiceId: invoiceId, currency: wanted, amountMinor: amount, reservationId: saved.id })]);
    return { ...rowResult(saved), reserved: true };
  });
}

async function markStripeApplied({ providerInvoiceId, providerAdjustmentId }) {
  const invoiceId = String(providerInvoiceId || '').trim(), adjustmentId = String(providerAdjustmentId || '').trim();
  if (!invoiceId || !adjustmentId) return null;
  return transaction(async client => {
    const candidate = (await client.query(`SELECT customer_id FROM affiliate_credit_renewal_reservations WHERE provider='stripe' AND provider_invoice_id=$1`, [invoiceId])).rows[0];
    if (!candidate) return null;
    await accounting.lockCustomer(client, candidate.customer_id);
    let row = (await client.query(`SELECT * FROM affiliate_credit_renewal_reservations WHERE provider='stripe' AND provider_invoice_id=$1 FOR UPDATE`, [invoiceId])).rows[0];
    if (!row) return null;
    if (row.provider_adjustment_id && String(row.provider_adjustment_id) !== adjustmentId) {
      throw identityConflict(`Stripe invoice ${invoiceId} already has a different service-credit provider adjustment.`);
    }
    if (!['reserved', 'provider_applied', 'consumed'].includes(row.state)) return rowResult(row);
    row = (await client.query(`UPDATE affiliate_credit_renewal_reservations SET state=CASE WHEN state='reserved' THEN 'provider_applied' ELSE state END,provider_adjustment_id=COALESCE(provider_adjustment_id,$2),applied_at=COALESCE(applied_at,NOW()),updated_at=NOW() WHERE id=$1 RETURNING *`, [row.id, adjustmentId])).rows[0];
    return rowResult(row);
  });
}

async function consumeStripeInvoice({ providerInvoiceId, providerAdjustmentId = null }) {
  const invoiceId = String(providerInvoiceId || '').trim();
  if (!invoiceId) return null;
  return transaction(async client => {
    const candidate = (await client.query(`SELECT customer_id FROM affiliate_credit_renewal_reservations WHERE provider='stripe' AND provider_invoice_id=$1`, [invoiceId])).rows[0];
    if (!candidate) return null;
    await accounting.lockCustomer(client, candidate.customer_id);
    let row = (await client.query(`SELECT * FROM affiliate_credit_renewal_reservations WHERE provider='stripe' AND provider_invoice_id=$1 FOR UPDATE`, [invoiceId])).rows[0];
    if (!row) return null;
    const suppliedAdjustmentId = String(providerAdjustmentId || '').trim();
    if (row.provider_adjustment_id && suppliedAdjustmentId && String(row.provider_adjustment_id) !== suppliedAdjustmentId) {
      throw identityConflict(`Stripe invoice ${invoiceId} settlement referenced a different service-credit provider adjustment.`);
    }
    if (row.state === 'consumed') return rowResult(row);
    if (row.state === 'released') return rowResult(row);
    const adjustmentId = suppliedAdjustmentId || String(row.provider_adjustment_id || '').trim();
    if (!adjustmentId) throw new Error(`Stripe renewal invoice ${invoiceId} has reserved service credit but no provider adjustment reference.`);
    if (row.state === 'reserved') {
      row = (await client.query(`UPDATE affiliate_credit_renewal_reservations SET state='provider_applied',provider_adjustment_id=$2,applied_at=COALESCE(applied_at,NOW()),updated_at=NOW() WHERE id=$1 RETURNING *`, [row.id, adjustmentId])).rows[0];
    }
    await accounting.ensureHistoricalAllocations(client, row.customer_id, row.currency);
    const referenceId = `stripe-renewal:${invoiceId}`;
    let debit = (await client.query(`INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,applied_subscription_id,reference_id,note,metadata) VALUES($1,$2,$3,'redeemed','available',$4,$5,'Applied service credit to Stripe renewal',$6::jsonb) ON CONFLICT(entry_type,reference_id) DO NOTHING RETURNING *`, [row.customer_id, row.currency, -int(row.amount_minor), row.subscription_id, referenceId, JSON.stringify({ renewal: true, provider: 'stripe', providerInvoiceId: invoiceId, providerAdjustmentId: adjustmentId, reservationId: row.id, subscriptionId: row.subscription_id })])).rows[0];
    if (!debit) debit = (await client.query(`SELECT * FROM affiliate_credit_ledger WHERE entry_type='redeemed' AND reference_id=$1 LIMIT 1`, [referenceId])).rows[0];
    if (!debit) throw new Error(`Service-credit renewal debit for Stripe invoice ${invoiceId} could not be recorded.`);
    await accounting.allocateOneDebit(client, debit);
    row = (await client.query(`UPDATE affiliate_credit_renewal_reservations SET state='consumed',provider_adjustment_id=COALESCE(provider_adjustment_id,$2),consumed_at=COALESCE(consumed_at,NOW()),updated_at=NOW() WHERE id=$1 RETURNING *`, [row.id, adjustmentId])).rows[0];
    await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('affiliate.credit.renewal.consume','subscription',$1,$2::jsonb)`, [String(row.subscription_id), JSON.stringify({ customerId: row.customer_id, provider: 'stripe', providerInvoiceId: invoiceId, providerAdjustmentId: adjustmentId, currency: row.currency, amountMinor: int(row.amount_minor), reservationId: row.id, debitLedgerId: debit.id })]);
    return rowResult(row);
  });
}

async function releaseStripeInvoice(providerInvoiceId, reason = 'invoice_not_paid') {
  const invoiceId = String(providerInvoiceId || '').trim();
  if (!invoiceId) return null;
  return transaction(async client => {
    const candidate = (await client.query(`SELECT customer_id FROM affiliate_credit_renewal_reservations WHERE provider='stripe' AND provider_invoice_id=$1`, [invoiceId])).rows[0];
    if (!candidate) return null;
    await accounting.lockCustomer(client, candidate.customer_id);
    const row = (await client.query(`UPDATE affiliate_credit_renewal_reservations SET state='released',released_at=COALESCE(released_at,NOW()),release_reason=$2,updated_at=NOW() WHERE provider='stripe' AND provider_invoice_id=$1 AND state IN('reserved','provider_applied') RETURNING *`, [invoiceId, String(reason || 'invoice_not_paid').slice(0, 500)])).rows[0];
    if (!row) {
      const existing = (await client.query(`SELECT * FROM affiliate_credit_renewal_reservations WHERE provider='stripe' AND provider_invoice_id=$1`, [invoiceId])).rows[0];
      return rowResult(existing);
    }
    await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('affiliate.credit.renewal.release','subscription',$1,$2::jsonb)`, [String(row.subscription_id), JSON.stringify({ customerId: row.customer_id, provider: 'stripe', providerInvoiceId: invoiceId, currency: row.currency, amountMinor: int(row.amount_minor), reservationId: row.id, reason: String(reason || 'invoice_not_paid').slice(0, 500) })]);
    return rowResult(row);
  });
}

module.exports = { cleanCurrency, reservationForStripeInvoice, reserveStripeInvoice, markStripeApplied, consumeStripeInvoice, releaseStripeInvoice };
