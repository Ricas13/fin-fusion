'use strict';

const { query, transaction } = require('../db');
const provisioning = require('../jellyfin/resilient-provisioning');
const manualSubscriptions = require('./manual-subscriptions');
const planCapacity = require('./plan-capacity');
const customerServerChoice = require('../jellyfin/customer-server-choice');
const subscriptionState = require('./subscription-state');
const serviceScope = require('./service-scope');

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
      AND COALESCE(service_type,'jellyfin') IN ('jellyfin','stremio','emby','bundle')
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
async function conflictingPrimarySubscription(customerId, plan, { client = null } = {}) {
  const db = client || { query };
  const result = await db.query(`
    SELECT s.*,p.*,s.id AS subscription_id,p.id AS plan_id,
           COALESCE(s.plan_name_snapshot,p.name) AS contract_plan_name,
           COALESCE(s.plan_code_snapshot,p.code) AS contract_plan_code
    FROM subscriptions s
    JOIN plans p ON p.id=s.plan_id
    LEFT JOIN customer_entitlement_overrides o
      ON o.customer_id=s.customer_id AND o.subscription_id=s.id
    WHERE s.customer_id=$1
      AND COALESCE(p.is_addon,FALSE)=FALSE
      AND s.superseded_by IS NULL
      AND s.starts_at<=NOW()
      AND (
        (o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id)
        OR (
          COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN('jellyfin','bundle')
          AND public.subscription_admin_present(s.customer_id,'jellyfin',s.id)
        )
        OR (s.status IN('active','trialing','past_due','paused') AND s.current_period_end>NOW())
        OR (
          COALESCE(s.service_extension_days,0)>0
          AND s.status IN('active','trialing','past_due','paused','cancelled','expired')
          AND (s.current_period_end+((s.service_extension_days||' days')::interval))>NOW()
        )
      )
    ORDER BY s.created_at DESC
  `, [customerId]);
  return result.rows.find(row => serviceScope.overlaps(row, plan)) || null;
}
async function grantablePlansForCustomer(customerId) {
  const plans = await grantPlans();
  const checks = await Promise.all(plans.map(async plan => ({
    plan,
    conflict: await conflictingPrimarySubscription(customerId, plan)
  })));
  return checks.filter(row => !row.conflict).map(row => row.plan);
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
        AND COALESCE(service_type,'jellyfin') IN ('jellyfin','stremio','emby','bundle')
      LIMIT 1
    `, [input.planId]);
    if (!planResult.rowCount) throw new Error('Choose an active standalone direct-customer plan.');
    const plan = planResult.rows[0];
    const existing = await conflictingPrimarySubscription(customerId, plan, { client });
    if (existing) throw new Error(`This customer already has overlapping current access (${existing.contract_plan_name || existing.name || 'active plan'}). Use Manual entitlement edit instead.`);
    const recognizedReference = recognizedProviderReference(input.method, input.externalReference);
    // Administrator grants intentionally bypass customer self-service trial-history
    // eligibility. A finished trial may be granted again by an administrator;
    // only overlapping live access is rejected above. Customer-initiated trials
    // still go through payments/lifecycle.enforceTrialEligibility().
    const adminTrialRegrant = plan.billing_interval === 'trial';
    const status = adminTrialRegrant ? 'trialing' : 'active';

    await planCapacity.lockAndAssert(client, plan.id, plan.name || 'This plan', {
      households: plan.stremio_household_network_limit || null
    });

    let mediaServer = null;
    let mediaLocation = null;
    if (customerServerChoice.mediaServerType(plan)) {
      mediaServer = await customerServerChoice.selectServerForLocationLocked(plan, null, {
        db: (sql, params) => client.query(sql, params),
        requireSelection: false
      });
      mediaLocation = mediaServer?.selected_location || customerServerChoice.locationLabel(mediaServer?.location);
    }
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
        adminTrialRegrant,
        note: input.note,
        renewal: false,
        chargedProvider: false
      }
    });
    if (mediaServer) {
      const assigned = await client.query(`
        UPDATE subscriptions
        SET media_server_id=$2,
            media_location_preference=$3,
            media_location_snapshot=$3,
            updated_at=NOW()
        WHERE id=$1 AND customer_id=$4
        RETURNING id
      `, [sub.id, mediaServer.id, mediaLocation, customerId]);
      if (!assigned.rowCount) throw new Error('Manual entitlement changed before its media-server reservation could be persisted.');
    }
    return { subscriptionId: sub.id, planName: plan.name, mediaServerId: mediaServer?.id || null, mediaLocation };
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
  conflictingPrimarySubscription,
  grantablePlansForCustomer,
  normalizedGrantInput,
  createManualGrant
};
