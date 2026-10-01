'use strict';

const { transaction } = require('../db');
const providerOps = require('./provider-operations');
const refundPolicy = require('./refund-policy');
const prepaidRefundLifecycle = require('./lifecycle-prepaid-refunds');
const provisioning = require('../jellyfin/resilient-provisioning');
const providerContract = require('./provider-contract');

const OPERATION_TYPE = 'prorata_refund';
const ELIGIBLE_STATUSES = new Set(['active','trialing','past_due','paused','cancelled']);

function isRecurring(row) {
  const ref = String(row?.provider_subscription_id || '');
  return (row?.source === 'stripe' && /^sub_/i.test(ref)) || (row?.source === 'paypal' && /^I-/i.test(ref));
}

function dateMs(value, label) {
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) throw new Error(`${label} is unavailable.`);
  return ms;
}

function cleanReason(value) {
  const reason = String(value || '').trim();
  if (reason.length < 3) throw new Error('Enter a refund reason.');
  return reason.slice(0, 500);
}

function commercialSnapshot(row) {
  const value = row?.commercial_snapshot;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function refundableQuoteFromRow(row, { refundedMinor = 0, now = new Date() } = {}) {
  if (!row) throw new Error('Subscription not found.');
  if (!['stripe','paypal'].includes(row.source)) throw new Error('Automated prepaid refunds are available only for Stripe and PayPal.');
  if (isRecurring(row)) throw new Error('Recurring provider subscriptions are not eligible for the prepaid pro-rata refund workflow.');
  if (!ELIGIBLE_STATUSES.has(String(row.status || '').toLowerCase())) throw new Error('This prepaid entitlement is not in a refundable state.');

  const startsMs = dateMs(row.starts_at, 'Subscription start');
  const endMs = dateMs(row.current_period_end, 'Subscription end');
  if (endMs <= startsMs) throw new Error('Subscription service period is invalid.');

  const nowMs = dateMs(now, 'Refund time');
  if (nowMs >= endMs) throw new Error('This prepaid entitlement has no unused service time left.');

  const snapshot = commercialSnapshot(row);
  const providerPaidMinor = refundPolicy.providerCashPaidMinor(snapshot);
  const remainingProviderCashMinor = refundPolicy.remainingProviderRefundableMinor({ providerPaidMinor, refundedMinor });
  if (remainingProviderCashMinor <= 0) throw new Error('No provider-paid cash remains refundable for this purchase.');

  const future = nowMs < startsMs;
  const cutoffMs = future ? startsMs : Math.max(startsMs, nowMs);
  const totalMs = endMs - startsMs;
  const unusedMs = endMs - cutoffMs;
  const refundableTotalAtCutoff = future ? providerPaidMinor : Math.floor((providerPaidMinor * unusedMs) / totalMs);
  const refundMinor = Math.max(0, Math.min(remainingProviderCashMinor, refundableTotalAtCutoff - Number(refundedMinor || 0)));
  if (refundMinor <= 0) throw new Error('The unused portion does not have any refundable provider-paid cash remaining.');

  const serviceCreditMinor = Math.max(0, Number(snapshot.serviceCreditMinor || 0));
  return {
    subscriptionId: row.id,
    customerId: row.customer_id,
    provider: row.source,
    providerReference: row.provider_subscription_id,
    currency: String(row.currency_snapshot || snapshot.currency || row.currency || 'GBP').toUpperCase(),
    planName: row.plan_name_snapshot || row.plan_name || row.plan_code_snapshot || 'Prepaid plan',
    serviceType: String(row.service_type_snapshot || row.service_type || 'jellyfin'),
    mode: future ? 'future_full' : 'active_prorata',
    startsAt: new Date(startsMs).toISOString(),
    originalEnd: new Date(endMs).toISOString(),
    cutoffAt: new Date(cutoffMs).toISOString(),
    totalServiceMs: totalMs,
    unusedServiceMs: unusedMs,
    unusedFraction: unusedMs / totalMs,
    providerPaidMinor,
    serviceCreditMinor,
    alreadyRefundedMinor: Number(refundedMinor || 0),
    remainingProviderCashMinor,
    refundMinor
  };
}

async function refundedMinorFor(client, row) {
  const result = await client.query(`
    SELECT amount_minor
    FROM payment_incidents
    WHERE customer_id=$1 AND provider=$2 AND provider_subscription_id=$3 AND incident_type='refund'
    ORDER BY created_at,id
  `, [row.customer_id, row.source, row.provider_subscription_id]);
  const amounts = result.rows.map(item => Math.max(0, Number(item.amount_minor || 0)));
  return row.source === 'stripe' ? (amounts.length ? Math.max(...amounts) : 0) : amounts.reduce((sum, amount) => sum + amount, 0);
}

async function loadForQuote(client, subscriptionId, { lock = false } = {}) {
  const result = await client.query(`
    SELECT s.*,p.name AS plan_name,p.service_type
    FROM subscriptions s
    JOIN plans p ON p.id=s.plan_id
    WHERE s.id=$1
    ${lock ? 'FOR UPDATE OF s' : ''}
  `, [subscriptionId]);
  return result.rows[0] || null;
}

async function quote(subscriptionId, { now = new Date() } = {}) {
  return transaction(async client => {
    const row = await loadForQuote(client, subscriptionId);
    if (!row) throw new Error('Subscription not found.');
    const refundedMinor = await refundedMinorFor(client, row);
    return refundableQuoteFromRow(row, { refundedMinor, now });
  });
}

function operationKey(quoteValue) {
  return providerOps.key([
    OPERATION_TYPE,
    quoteValue.provider,
    quoteValue.subscriptionId,
    quoteValue.originalEnd,
    quoteValue.alreadyRefundedMinor,
    quoteValue.refundMinor
  ]);
}

async function planOperation(subscriptionId, actorUserId, reason) {
  const note = cleanReason(reason);
  return transaction(async client => {
    const row = await loadForQuote(client, subscriptionId, { lock: true });
    if (!row) throw new Error('Subscription not found.');
    const refundedMinor = await refundedMinorFor(client, row);
    const current = refundableQuoteFromRow(row, { refundedMinor, now: new Date() });
    const idempotencyKey = operationKey(current);
    const request = { ...current, actorUserId: actorUserId || null, reason: note };
    const inserted = await client.query(`
      INSERT INTO provider_operations(
        provider,scope,owner_id,operation_type,local_reference,idempotency_key,request_snapshot,state,next_attempt_at
      ) VALUES($1,'customer',$2,$3,$4,$5,$6::jsonb,'planned',NOW())
      ON CONFLICT(idempotency_key) DO UPDATE SET updated_at=NOW()
      RETURNING *
    `, [current.provider, current.customerId, OPERATION_TYPE, current.subscriptionId, idempotencyKey, JSON.stringify(request)]);
    return { operation: inserted.rows[0], quote: current };
  });
}

async function createOrObserveProviderRefund(op) {
  const request = op.request_snapshot || {};
  return providerContract.refunds(request.provider).createOrObserve(op, request);
}

function providerRefundComplete(provider, status) {
  return providerContract.refunds(provider).isComplete(status);
}

async function applyLocal(op) {
  const request = op.request_snapshot || {};
  const lifecycleResult = await prepaidRefundLifecycle.applyPrepaidRefund({
    subscriptionId: request.subscriptionId,
    customerId: request.customerId,
    originalEnd: request.originalEnd,
    cutoffAt: request.cutoffAt,
    serviceType: request.serviceType
  });
  await transaction(async client => {
    const attempt = providerOps.expectedAttempt(op.id);
    const updated = await client.query(`
      UPDATE provider_operations
      SET state='local_applied',local_applied_at=COALESCE(local_applied_at,NOW()),last_error=NULL,
          failure_kind=NULL,manual_review_required=FALSE,next_attempt_at=NOW()+INTERVAL '5 minutes',updated_at=NOW()
      WHERE id=$1 AND ($2::int IS NULL OR attempt_count=$2)
      RETURNING id
    `, [op.id,attempt]);
    if (!updated.rowCount && attempt != null) throw providerOps.leaseLost(op.id);
    await client.query(`
      INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'admin.prepaid.prorata_refund','subscription',$2,$3::jsonb)
    `, [request.actorUserId || null, String(request.subscriptionId), JSON.stringify({
      provider: request.provider,
      providerRefundId: op.provider_reference || null,
      providerPaidMinor: request.providerPaidMinor,
      serviceCreditMinor: request.serviceCreditMinor,
      alreadyRefundedMinor: request.alreadyRefundedMinor,
      refundedMinor: request.refundMinor,
      currency: request.currency,
      mode: request.mode,
      originalEnd: request.originalEnd,
      cutoffAt: request.cutoffAt,
      removedServiceMs: lifecycleResult.removedMs,
      reason: request.reason,
      providerOperationId: op.id
    })]);
  });
}

async function recoverProviderOperation(operation) {
  let op = operation;
  if (!op || op.operation_type !== OPERATION_TYPE) throw new Error('Not a pro-rata refund operation.');
  const request = op.request_snapshot || {};

  if (op.state === 'planned') {
    const remote = await createOrObserveProviderRefund(op);
    op = await providerOps.providerApplied(op.id, { providerReference: remote.id, result: { refundStatus: remote.status, ...remote.raw } });
  }

  if (op.state === 'provider_applied') {
    const remote = await createOrObserveProviderRefund(op);
    await providerOps.observed(op.id, { result: { refundStatus: remote.status, ...remote.raw } });
    if (!providerRefundComplete(request.provider, remote.status)) {
      if (['failed','canceled','cancelled'].includes(remote.status)) throw new Error(`Provider refund is ${remote.status}; manual review is required.`);
      throw new Error(`Provider refund is ${remote.status || 'pending'} and has not completed yet.`);
    }
    await applyLocal({ ...op, provider_reference: remote.id });
    op = await providerOps.get(op.id);
  }

  if (op.state === 'local_applied') {
    await provisioning.reconcileCustomer(request.customerId);
    op = await providerOps.reconciled(op.id, { result: { refundMinor: request.refundMinor, currency: request.currency, cutoffAt: request.cutoffAt } });
  }

  return { ok: op.state === 'reconciled', operation: op };
}

async function execute({ subscriptionId, actorUserId = null, reason } = {}) {
  const planned = await planOperation(subscriptionId, actorUserId, reason);
  if (planned.operation.state === 'reconciled') return { quote: planned.quote, operation: planned.operation, alreadyCompleted: true };
  const result = await recoverProviderOperation(planned.operation);
  return { quote: planned.quote, operation: result.operation, alreadyCompleted: false };
}

module.exports = {
  OPERATION_TYPE,
  isRecurring,
  refundableQuoteFromRow,
  refundedMinorFor,
  quote,
  execute,
  recoverProviderOperation,
  providerRefundComplete
};