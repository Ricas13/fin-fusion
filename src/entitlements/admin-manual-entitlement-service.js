'use strict';

const { query, transaction } = require('../db');
const provisioning = require('../jellyfin/resilient-provisioning');
const manualSubscriptions = require('./manual-subscriptions');
const subscriptionState = require('./subscription-state');

const METHODS = new Set(['paypal', 'stripe', 'bank', 'other']);
const CURRENCIES = new Set(['GBP', 'USD', 'EUR']);

function text(value, max = 500) { return String(value || '').trim().slice(0, max); }
function isoDate(value) {
  const raw = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error('Enter a valid date.');
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) throw new Error('Enter a valid date.');
  return date;
}
function moneyMinor(value) {
  const raw = text(value, 30);
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error('Enter a valid non-negative amount with no more than two decimal places.');
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0 || amount > 100000) throw new Error('Amount must be between 0 and 100,000.');
  return Math.round(amount * 100);
}
function recognizedProviderReference(method, externalReference) {
  const ref = text(externalReference, 255);
  if (method === 'stripe' && /^sub_[A-Za-z0-9_\-]+$/.test(ref)) return ref;
  if (method === 'paypal' && /^I-[A-Za-z0-9\-]+$/i.test(ref)) return ref;
  return null;
}
async function grantPlans() {
  const result = await query(`
    SELECT id,code,name,service_type,billing_interval,duration_days,price_minor,currency
    FROM plans
    WHERE active=TRUE
      AND archived_at IS NULL
      AND (effective_from IS NULL OR effective_from<=NOW())
      AND (effective_until IS NULL OR effective_until>NOW())
      AND audience IN('direct','both')
      AND COALESCE(is_addon,FALSE)=FALSE
      AND COALESCE(service_type,'jellyfin') IN ('jellyfin','stremio')
    ORDER BY sort_order,price_minor,name
  `);
  return result.rows;
}
async function currentPrimarySubscription(customerId) {
  const row = await subscriptionState.livePrimarySubscription(customerId);
  return row ? {
    id: row.subscription_id || row.id,
    status: row.status,
    current_period_end: row.current_period_end,
    plan_name: row.contract_plan_name || row.name || null
  } : null;
}
function normalizedGrantInput(body = {}) {
  const method = text(body.method, 20).toLowerCase();
  if (!METHODS.has(method)) throw new Error('Choose a valid payment or grant method.');
  const currency = text(body.currency, 3).toUpperCase();
  if (!CURRENCIES.has(currency)) throw new Error('Currency must be GBP, USD or EUR.');
  if (String(body.confirm || '') !== '1') throw new Error('Confirm that this action does not charge the provider.');
  const startAt = isoDate(body.startDate);
  const endAt = isoDate(body.endDate);
  if (endAt.getTime() <= startAt.getTime()) throw new Error('End date must be after the start date.');
  return {
    planId: text(body.planId, 80),
    method,
    currency,
    amountMinor: moneyMinor(body.amount),
    startAt,
    endAt,
    externalReference: text(body.externalReference, 255) || null,
    note: text(body.note, 500) || null,
    returnTab: body.returnTab === 'billing' ? 'billing' : 'access'
  };
}
async function createManualGrant(customerId, actorUserId, input) {
  const created = await transaction(async client => {
    const customer = await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [customerId]);
    if (!customer.rowCount) throw new Error('Customer not found.');
    const planResult = await client.query(`
      SELECT * FROM plans
      WHERE id=$1
        AND active=TRUE
        AND archived_at IS NULL
        AND (effective_from IS NULL OR effective_from<=NOW())
        AND (effective_until IS NULL OR effective_until>NOW())
        AND audience IN('direct','both')
        AND COALESCE(is_addon,FALSE)=FALSE
        AND COALESCE(service_type,'jellyfin') IN ('jellyfin','stremio')
      LIMIT 1
    `, [input.planId]);
    if (!planResult.rowCount) throw new Error('Choose an active standalone direct-customer plan.');
    const plan = planResult.rows[0];
    const existing = await subscriptionState.livePrimarySubscription(customerId, { client });
    if (existing) throw new Error(`This customer already has a current primary subscription (${existing.contract_plan_name || existing.name || 'active plan'}). Use Manual entitlement edit instead.`);
    const recognizedReference = recognizedProviderReference(input.method, input.externalReference);
    const status = plan.billing_interval === 'trial' ? 'trialing' : 'active';
    const sub = await manualSubscriptions.createManualSubscriptionTx(client, {
      customerId,
      planId: plan.id,
      startsAt: input.startAt,
      endsAt: input.endAt,
      actorUserId,
      source: 'admin_grant',
      status,
      auditAction: 'admin.customer.manual_grant',
      auditMetadata: {
        planCode: plan.code,
        planName: plan.name,
        serviceType: plan.service_type || 'jellyfin',
        startsAt: input.startAt.toISOString(),
        endsAt: input.endAt.toISOString(),
        amountMinor: input.amountMinor,
        currency: input.currency,
        method: input.method,
        externalReference: input.externalReference,
        recognizedProviderReference: recognizedReference,
        providerLinked: false,
        note: input.note,
        renewal: false,
        chargedProvider: false
      }
    });
    return { subscriptionId: sub.id, planName: plan.name };
  });
  try {
    await provisioning.reconcileCustomer(customerId);
    return { ...created, reconciled: true };
  } catch (error) {
    console.error('Manual customer entitlement reconciliation failed:', { customerId, error: error.message });
    return { ...created, reconciled: false };
  }
}

module.exports = {
  METHODS,
  CURRENCIES,
  text,
  isoDate,
  moneyMinor,
  recognizedProviderReference,
  grantPlans,
  currentPrimarySubscription,
  normalizedGrantInput,
  createManualGrant
};
