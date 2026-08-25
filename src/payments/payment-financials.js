'use strict';

const { query } = require('../db');

function decimalToMinor(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');
  const minor = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  return negative ? -minor : minor;
}

function cleanCurrency(value) {
  const currency = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function integerOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

async function record(input) {
  if (!input?.provider || !input?.providerEventId) return null;
  const grossMinor = integerOrNull(input.grossMinor);
  const feeMinor = integerOrNull(input.feeMinor);
  const netMinor = integerOrNull(input.netMinor ?? (grossMinor != null && feeMinor != null ? grossMinor - feeMinor : null));
  const currency = cleanCurrency(input.currency);
  const feeSource = ['provider_actual', 'derived', 'unavailable'].includes(input.feeSource) ? input.feeSource : (feeMinor == null ? 'unavailable' : 'provider_actual');
  const result = await query(`
    INSERT INTO payment_financials(provider,provider_event_id,event_type,gross_minor,fee_minor,net_minor,currency,fee_source,provider_reference,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    ON CONFLICT(provider,provider_event_id) DO UPDATE SET
      event_type=EXCLUDED.event_type,
      gross_minor=COALESCE(EXCLUDED.gross_minor,payment_financials.gross_minor),
      fee_minor=COALESCE(EXCLUDED.fee_minor,payment_financials.fee_minor),
      net_minor=COALESCE(EXCLUDED.net_minor,payment_financials.net_minor),
      currency=COALESCE(EXCLUDED.currency,payment_financials.currency),
      fee_source=CASE WHEN EXCLUDED.fee_source='unavailable' THEN payment_financials.fee_source ELSE EXCLUDED.fee_source END,
      provider_reference=COALESCE(EXCLUDED.provider_reference,payment_financials.provider_reference),
      metadata=payment_financials.metadata || EXCLUDED.metadata,
      updated_at=NOW()
    RETURNING *
  `, [input.provider, String(input.providerEventId), input.eventType || null, grossMinor, feeMinor, netMinor, currency, feeSource, input.providerReference || null, JSON.stringify(input.metadata || {})]);
  return result.rows[0] || null;
}

function findStringByPattern(value, pattern, depth = 0, seen = new Set()) {
  if (depth > 7 || value == null) return null;
  if (typeof value === 'string') return pattern.test(value) ? value : null;
  if (typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByPattern(item, pattern, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }
  for (const item of Object.values(value)) {
    const found = findStringByPattern(item, pattern, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

async function stripeChargeFinancials(stripe, chargeLike, fallback = {}) {
  if (!chargeLike) return null;
  let charge = chargeLike;
  if (typeof charge === 'string') {
    charge = await stripe.charges.retrieve(charge, { expand: ['balance_transaction'] });
  } else if (charge?.id && typeof charge.balance_transaction === 'string') {
    charge = await stripe.charges.retrieve(charge.id, { expand: ['balance_transaction'] });
  }
  let balance = charge?.balance_transaction || null;
  if (typeof balance === 'string') balance = await stripe.balanceTransactions.retrieve(balance);
  const grossMinor = integerOrNull(charge?.amount ?? fallback.grossMinor);
  const currency = cleanCurrency(charge?.currency || balance?.currency || fallback.currency);
  const feeMinor = integerOrNull(balance?.fee);
  const netMinor = integerOrNull(balance?.net);
  return {
    grossMinor,
    feeMinor,
    netMinor,
    currency,
    feeSource: feeMinor == null ? 'unavailable' : 'provider_actual',
    providerReference: charge?.id || fallback.providerReference || null,
    metadata: balance?.id ? { balanceTransactionId: balance.id } : {}
  };
}

async function stripePaymentIntentFinancials(stripe, paymentIntentLike, fallback = {}) {
  if (!paymentIntentLike) return null;
  let paymentIntent = paymentIntentLike;
  if (typeof paymentIntent === 'string') {
    paymentIntent = await stripe.paymentIntents.retrieve(paymentIntent, { expand: ['latest_charge.balance_transaction'] });
  }
  if (paymentIntent?.latest_charge) return stripeChargeFinancials(stripe, paymentIntent.latest_charge, fallback);
  const paymentIntentId = paymentIntent?.id || (typeof paymentIntentLike === 'string' ? paymentIntentLike : null);
  if (!paymentIntentId) return null;
  const charges = await stripe.charges.list({ payment_intent: paymentIntentId, limit: 3 });
  const charge = charges?.data?.find(row => row?.paid && !row?.refunded) || charges?.data?.[0] || null;
  return stripeChargeFinancials(stripe, charge, fallback);
}

async function stripeEventFinancials(event, stripe) {
  const object = event?.data?.object || {};
  let grossMinor = null;
  let currency = null;
  let paymentIntent = null;
  if (event?.type === 'checkout.session.completed' && object.mode === 'payment' && ['paid', 'no_payment_required'].includes(object.payment_status)) {
    grossMinor = integerOrNull(object.amount_total);
    currency = cleanCurrency(object.currency);
    paymentIntent = object.payment_intent || null;
  } else if (event?.type === 'invoice.paid') {
    grossMinor = integerOrNull(object.amount_paid);
    currency = cleanCurrency(object.currency);
    paymentIntent = object.payment_intent || null;
    if (!paymentIntent && object.id && stripe.invoicePayments && typeof stripe.invoicePayments.list === 'function') {
      try {
        const payments = await stripe.invoicePayments.list({ invoice: object.id, limit: 10 });
        paymentIntent = findStringByPattern(payments?.data || [], /^pi_[A-Za-z0-9]+$/);
      } catch (error) {
        console.warn('Stripe invoice payment lookup did not expose a PaymentIntent:', error.message);
      }
    }
  } else return null;

  let details = null;
  if (paymentIntent) {
    try {
      details = await stripePaymentIntentFinancials(stripe, paymentIntent, { grossMinor, currency });
    } catch (error) {
      console.warn(`Stripe fee lookup failed for ${event.type}:`, error.message);
    }
  }
  return record({
    provider: 'stripe',
    providerEventId: event.id,
    eventType: event.type,
    grossMinor: details?.grossMinor ?? grossMinor,
    feeMinor: details?.feeMinor ?? null,
    netMinor: details?.netMinor ?? null,
    currency: details?.currency || currency,
    feeSource: details?.feeSource || 'unavailable',
    providerReference: details?.providerReference || (typeof paymentIntent === 'string' ? paymentIntent : paymentIntent?.id) || object.id || null,
    metadata: details?.metadata || {}
  });
}

function paypalEventValues(event) {
  const resource = event?.resource || {};
  if (event?.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
    const grossMinor = decimalToMinor(resource.amount?.value);
    const feeMinor = decimalToMinor(resource.seller_receivable_breakdown?.paypal_fee?.value);
    const netMinor = decimalToMinor(resource.seller_receivable_breakdown?.net_amount?.value);
    return {
      grossMinor,
      feeMinor: feeMinor ?? (grossMinor != null && netMinor != null ? grossMinor - netMinor : null),
      netMinor,
      currency: resource.amount?.currency_code || resource.seller_receivable_breakdown?.net_amount?.currency_code,
      providerReference: resource.id || null
    };
  }
  if (event?.event_type === 'PAYMENT.SALE.COMPLETED') {
    const grossMinor = decimalToMinor(resource.amount?.total ?? resource.amount?.value);
    const feeMinor = decimalToMinor(resource.transaction_fee?.value ?? resource.transaction_fee?.amount);
    return {
      grossMinor,
      feeMinor,
      netMinor: grossMinor != null && feeMinor != null ? grossMinor - feeMinor : null,
      currency: resource.amount?.currency || resource.amount?.currency_code || resource.transaction_fee?.currency,
      providerReference: resource.id || null
    };
  }
  return null;
}

async function paypalEventFinancials(event) {
  const values = paypalEventValues(event);
  if (!values) return null;
  return record({
    provider: 'paypal',
    providerEventId: event.id,
    eventType: event.event_type,
    ...values,
    feeSource: values.feeMinor == null ? 'unavailable' : 'provider_actual'
  });
}

function firstMoneyMinor(values) {
  for (const value of values) {
    const minor = decimalToMinor(value);
    if (minor != null && minor >= 0) return minor;
  }
  return null;
}

async function plisioOperationFinancials({ eventId, eventType, remote = {}, fallback = {} }) {
  const grossMinor = firstMoneyMinor([remote.source_amount, remote.amount, remote.invoice_total, fallback.sourceAmount]);
  const feeMinor = firstMoneyMinor([remote.fee, remote.fee_amount, remote.source_fee, remote.txn_fee, remote.network_fee, remote.params?.fee]);
  const currency = cleanCurrency(remote.source_currency || remote.currency || fallback.sourceCurrency);
  return record({
    provider: 'plisio',
    providerEventId: eventId,
    eventType,
    grossMinor,
    feeMinor,
    netMinor: grossMinor != null && feeMinor != null ? grossMinor - feeMinor : null,
    currency,
    feeSource: feeMinor == null ? 'unavailable' : 'provider_actual',
    providerReference: remote.txn_id || remote.id || null,
    metadata: feeMinor == null ? { feeUnavailable: true } : {}
  });
}

module.exports = {
  decimalToMinor,
  cleanCurrency,
  record,
  findStringByPattern,
  stripeChargeFinancials,
  stripePaymentIntentFinancials,
  stripeEventFinancials,
  paypalEventValues,
  paypalEventFinancials,
  plisioOperationFinancials
};
