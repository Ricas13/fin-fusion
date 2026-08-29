'use strict';

const crypto = require('crypto');
const Stripe = require('stripe');
const { query, transaction } = require('../db');
const providerSettings = require('./provider-settings');
const providerHttp = require('./provider-http');
const providerOps = require('./provider-operations');
const refundPolicy = require('./refund-policy');
const buildInfo = require('../build-info');
const provisioning = require('../jellyfin/resilient-provisioning');

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
  const refundableTotalAtCutoff = future
    ? providerPaidMinor
    : Math.floor((providerPaidMinor * unusedMs) / totalMs);
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

async function stripeClient() {
  const cfg = await providerSettings.get('stripe');
  const key = cfg.restrictedKey || cfg.apiKey || '';
  if (!key) throw new Error('Stripe is not configured.');
  return new Stripe(key, {
    apiVersion: '2026-06-24.dahlia',
    appInfo: buildInfo.providerAppInfo(),
    timeout: providerHttp.timeoutMs('stripe')
  });
}

function paypalBaseUrl(config) {
  return config.environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

async function paypalSession() {
  const cfg = await providerSettings.get('paypal');
  if (!cfg.clientId || !cfg.clientSecret) throw new Error('PayPal is not configured.');
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const result = await providerHttp.fetchJson('paypal', `${paypalBaseUrl(cfg)}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!result.response.ok || !result.data?.access_token) throw providerHttp.responseError('paypal', result.response, result.data, result.requestId, 'PayPal authentication failed.');
  return { cfg, token: result.data.access_token };
}

async function paypalRequest(path, { method = 'GET', body = null, idempotencyKey = null } = {}) {
  const { cfg, token } = await paypalSession();
  const result = await providerHttp.fetchJson('paypal', `${paypalBaseUrl(cfg)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(idempotencyKey ? { 'PayPal-Request-Id': String(idempotencyKey).slice(0,108) } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!result.response.ok) throw providerHttp.responseError('paypal', result.response, result.data, result.requestId, `PayPal refund request failed (${result.response.status}).`);
  return result.data || {};
}

async function createOrObserveProviderRefund(op) {
  const request = op.request_snapshot || {};
  if (request.provider === 'stripe') {
    const client = await stripeClient();
    let refund;
    if (op.provider_reference) refund = await client.refunds.retrieve(op.provider_reference);
    else refund = await client.refunds.create({
      payment_intent: request.providerReference,
      amount: Number(request.refundMinor),
      metadata: {
        captainfin_operation_id: String(op.id),
        captainfin_subscription_id: String(request.subscriptionId),
        reason: String(request.reason || '').slice(0,250)
      }
    }, { idempotencyKey: op.idempotency_key });
    return { id: refund.id, status: String(refund.status || '').toLowerCase(), raw: { status: refund.status || null, paymentIntent: refund.payment_intent || request.providerReference } };
  }
  if (request.provider === 'paypal') {
    let refund;
    if (op.provider_reference) refund = await paypalRequest(`/v2/payments/refunds/${encodeURIComponent(op.provider_reference)}`);
    else refund = await paypalRequest(`/v2/payments/captures/${encodeURIComponent(request.providerReference)}/refund`, {
      method: 'POST',
      idempotencyKey: op.idempotency_key,
      body: { amount: { value: (Number(request.refundMinor) / 100).toFixed(2), currency_code: request.currency } }
    });
    return { id: refund.id, status: String(refund.status || '').toLowerCase(), raw: { status: refund.status || null, captureId: request.providerReference } };
  }
  throw new Error('Unsupported pro-rata refund provider.');
}

function providerRefundComplete(provider, status) {
  return provider === 'stripe' ? status === 'succeeded' : status === 'completed';
}

async function applyLocal(op) {
  const request = op.request_snapshot || {};
  await transaction(async client => {
    const row = await loadForQuote(client, request.subscriptionId, { lock: true });
    if (!row || String(row.customer_id) !== String(op.owner_id)) throw new Error('Refunded prepaid subscription no longer exists.');

    const originalEndMs = dateMs(request.originalEnd, 'Original service end');
    const cutoffMs = dateMs(request.cutoffAt, 'Refund cutoff');
    if (cutoffMs > originalEndMs) throw new Error('Refund cutoff exceeds the original service end.');
    const removedMs = Math.max(0, originalEndMs - cutoffMs);
    const originalEnd = new Date(originalEndMs);
    const cutoff = new Date(cutoffMs);

    if (removedMs > 0) {
      await client.query(`
        UPDATE subscriptions
        SET current_period_end=$2,status='expired',service_extension_days=0,updated_at=NOW()
        WHERE id=$1
      `, [row.id, cutoff]);

      await client.query(`
        UPDATE subscriptions queued
        SET starts_at=queued.starts_at-($4::bigint * INTERVAL '1 millisecond'),
            current_period_end=queued.current_period_end-($4::bigint * INTERVAL '1 millisecond'),
            updated_at=NOW()
        FROM plans qp
        WHERE queued.plan_id=qp.id
          AND queued.customer_id=$1
          AND queued.id<>$2
          AND queued.superseded_by IS NULL
          AND queued.starts_at >= $3
          AND queued.status IN ('active','trialing','past_due','paused','cancelled')
          AND queued.source IN ('stripe','paypal','plisio')
          AND NOT (queued.source='stripe' AND COALESCE(queued.provider_subscription_id,'') ~* '^sub_')
          AND NOT (queued.source='paypal' AND COALESCE(queued.provider_subscription_id,'') ~* '^I-')
          AND (
            COALESCE(queued.service_type_snapshot,qp.service_type,'jellyfin')='bundle'
            OR $5='bundle'
            OR COALESCE(queued.service_type_snapshot,qp.service_type,'jellyfin')=$5
          )
      `, [row.customer_id, row.id, originalEnd, removedMs, request.serviceType]);
    }

    await client.query(`
      UPDATE provider_operations
      SET state='local_applied',local_applied_at=COALESCE(local_applied_at,NOW()),last_error=NULL,
          failure_kind=NULL,manual_review_required=FALSE,next_attempt_at=NOW()+INTERVAL '5 minutes',updated_at=NOW()
      WHERE id=$1
    `, [op.id]);
    await client.query(`
      INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'admin.prepaid.prorata_refund','subscription',$2,$3::jsonb)
    `, [request.actorUserId || null, String(row.id), JSON.stringify({
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
