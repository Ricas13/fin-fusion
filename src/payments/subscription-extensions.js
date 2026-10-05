'use strict';

const { query, transaction } = require('../db');
const billingPeriods = require('./billing-periods');
const planPricing = require('./plan-pricing');

const PURCHASE_KIND = 'subscription_extension';
const EVENT_SOURCE_PREFIX = 'customer_paid_extension:';
const DAY_MS = 24 * 60 * 60 * 1000;
const LEGACY_EVENT_MAX_DAYS = 365;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIVE_OR_PAID_THROUGH_STATUSES = new Set(['active','trialing','past_due','paused','cancelled','expired']);

function safeObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value };
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }
  return {};
}

function isExtensionSnapshot(snapshot) {
  const value = safeObject(snapshot);
  return value.kind === 'direct_plan' && value.purchaseKind === PURCHASE_KIND;
}

function eventSource(provider) {
  const name = String(provider || '').trim().toLowerCase();
  if (!['stripe','paypal','plisio'].includes(name)) throw new Error('Unsupported extension payment provider.');
  return `${EVENT_SOURCE_PREFIX}${name}`;
}

function positiveInt(value, fallback = null) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function accessKind(plan) {
  const service = String(plan?.service_type || 'jellyfin').toLowerCase();
  return service === 'stremio' ? 'households' : 'streams';
}

function baseAccessQuantity(plan) {
  const kind = accessKind(plan);
  return kind === 'households'
    ? Math.max(1, positiveInt(plan?.stremio_household_network_limit, 1))
    : Math.max(1, positiveInt(plan?.streams, 1));
}

function subscriptionAccessQuantity(subscription, plan) {
  const snapshot = safeObject(subscription?.commercial_snapshot);
  const kind = String(snapshot.accessVariantKind || accessKind(plan));
  const fallback = baseAccessQuantity(plan);
  return {
    kind: ['streams','households'].includes(kind) ? kind : accessKind(plan),
    quantity: positiveInt(snapshot.accessQuantity, fallback)
  };
}

function wholeDaysBetween(from, to) {
  const start = new Date(from), end = new Date(to);
  const exact = (end.getTime() - start.getTime()) / DAY_MS;
  const rounded = Math.round(exact);
  if (!Number.isFinite(exact) || rounded < 1 || Math.abs(exact - rounded) > 1e-7) {
    const error = new Error('Subscription extension duration could not be represented safely as whole service days.');
    error.code = 'SUBSCRIPTION_EXTENSION_DURATION_INVALID';
    throw error;
  }
  return rounded;
}

function addFixedDays(from, days) {
  return new Date(new Date(from).getTime() + Number(days) * DAY_MS);
}

function eventDaysForAudit(appliedDays) {
  const days = Math.max(1, Math.min(3650, Number(appliedDays) || 1));
  // The existing zero-downtime schema intentionally caps this legacy audit
  // column at 365. Exact calendar/custom duration lives in metadata.appliedDays
  // and billingInterval/durationDays, so a leap-year or long custom term does
  // not require a live schema change that would make the N-1 web runtime fail
  // readiness during deployment overlap.
  return Math.min(LEGACY_EVENT_MAX_DAYS, Math.ceil(days));
}

function extensionTerms(snapshot, fallbackDays = 30) {
  const value = safeObject(snapshot);
  const billingInterval = String(value.billingInterval || '').trim().toLowerCase();
  const durationDays = Math.max(1, positiveInt(value.durationDays, positiveInt(fallbackDays, 30)));
  if (billingInterval === 'trial') throw new Error('Trial plans cannot be purchased as subscription extensions.');
  return { billing_interval: billingInterval, duration_days: durationDays };
}

function projectedEnd(from, snapshot, fallbackDays = 30) {
  return billingPeriods.addPlanDuration(extensionTerms(snapshot, fallbackDays), new Date(from));
}

function appliedDaysFromMetadata(event) {
  const metadata = safeObject(event?.metadata);
  const stored = Number(metadata.appliedDays);
  if (Number.isInteger(stored) && stored >= 0 && stored <= 3650) return stored;
  const fallback = Number(event?.days);
  return Number.isInteger(fallback) && fallback > 0 ? fallback : 0;
}

function paidEventActive(event) {
  const metadata = safeObject(event?.metadata);
  return metadata.refunded !== true && metadata.consumed !== true && metadata.invalidated !== true;
}

async function loadSubscriptionTx(client, subscriptionId, customerId = null) {
  const params = [subscriptionId];
  let customerSql = '';
  if (customerId) {
    params.push(customerId);
    customerSql = ' AND s.customer_id=$2';
  }
  const result = await client.query(`
    SELECT s.*,s.id AS subscription_id,
           p.id AS plan_id,p.code AS plan_code,p.name AS plan_name,p.service_type,
           p.audience,p.active AS plan_active,p.visible AS plan_visible,p.archived_at,
           p.effective_from,p.effective_until,p.is_addon,p.is_free_tier,
           p.billing_interval,p.duration_days,p.price_minor,p.currency,p.streams,
           p.stremio_household_network_limit
    FROM subscriptions s
    JOIN plans p ON p.id=s.plan_id
    WHERE s.id=$1${customerSql}
    FOR UPDATE OF s
  `, params);
  return result.rows[0] || null;
}

function assertExtendableSubscription(row, { planId = null, planCode = null, now = new Date() } = {}) {
  if (!row) throw new Error('The subscription to extend was not found.');
  if (planId && String(row.plan_id) !== String(planId)) throw new Error('The extension plan no longer matches the current subscription.');
  if (planCode && String(row.plan_code) !== String(planCode)) throw new Error('Only the current plan can be extended.');
  if (row.superseded_by) throw new Error('This subscription has already been replaced and cannot be extended.');
  if (row.refund_terminated_at) throw new Error('A refunded or charged-back subscription cannot be extended.');
  if (!LIVE_OR_PAID_THROUGH_STATUSES.has(String(row.status || '').toLowerCase())) throw new Error('This subscription is not in an extendable state.');
  if (row.is_addon) throw new Error('Add-on subscriptions cannot be extended through this checkout.');
  if (row.is_free_tier || Number(row.price_minor || 0) <= 0 || String(row.billing_interval || '') === 'trial') {
    throw new Error('Only a current paid non-trial plan can be extended.');
  }
  if (!['direct','both'].includes(String(row.audience || 'direct'))) throw new Error('This plan is not available to direct customers.');
  if (!row.plan_active || !row.plan_visible || row.archived_at) throw new Error('This plan is no longer available for extension.');
  const start = new Date(row.starts_at), end = addFixedDays(row.current_period_end, Number(row.service_extension_days || 0));
  if (!Number.isFinite(start.getTime()) || start > now || !Number.isFinite(end.getTime()) || end <= now) {
    throw new Error('This subscription no longer has paid-through access to extend.');
  }
  const effectiveFrom = row.effective_from ? new Date(row.effective_from) : null;
  const effectiveUntil = row.effective_until ? new Date(row.effective_until) : null;
  if (effectiveFrom && effectiveFrom > now) throw new Error('This plan is not yet available for extension.');
  if (effectiveUntil && effectiveUntil <= now) throw new Error('This plan is no longer available for extension.');
  return row;
}

async function recomputeForSubscriptionTx(client, subscriptionId) {
  const row = await loadSubscriptionTx(client, subscriptionId);
  if (!row) throw new Error('Subscription not found while recalculating service extensions.');
  if (row.refund_terminated_at) {
    if (Number(row.service_extension_days || 0) !== 0) {
      await client.query('UPDATE subscriptions SET service_extension_days=0,updated_at=NOW() WHERE id=$1', [row.id]);
      row.service_extension_days = 0;
    }
    return { row, serviceExtensionDays:0, accessExpiresAt:new Date(row.current_period_end) };
  }

  const events = (await client.query(`
    SELECT id,subscription_id,customer_id,source,days,reference_id,metadata,created_at
    FROM subscription_service_extension_events
    WHERE subscription_id=$1 AND LEFT(source,$2)=$3
    ORDER BY created_at,id
    FOR UPDATE
  `, [row.id, EVENT_SOURCE_PREFIX.length, EVENT_SOURCE_PREFIX])).rows;

  let oldPaidDays = events.reduce((sum, event) => sum + appliedDaysFromMetadata(event), 0);
  const currentTotal = Math.max(0, Number(row.service_extension_days || 0));
  if (!Number.isInteger(currentTotal)) throw new Error('Stored service-extension total is invalid.');
  if (currentTotal < oldPaidDays) {
    // Another canonical lifecycle action (natural expiry, explicit set-expiry,
    // refund termination, etc.) has already cleared or shortened service time.
    // Never resurrect paid time from an audit event after canonical entitlement
    // truth has removed it. Retire the old applied contribution and preserve the
    // current subscription total as the new non-paid baseline.
    for (const event of events) {
      const metadata = safeObject(event.metadata);
      if (appliedDaysFromMetadata(event) <= 0) continue;
      const nextMetadata = {
        ...metadata,
        appliedDays:0,
        invalidated:true,
        invalidatedAt:new Date().toISOString(),
        invalidatedReason:'canonical_service_extension_reset'
      };
      await client.query('UPDATE subscription_service_extension_events SET metadata=$2::jsonb WHERE id=$1', [event.id, JSON.stringify(nextMetadata)]);
      event.metadata = nextMetadata;
    }
    await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('payment.subscription_extension.state_reset_detected','subscription',$1,$2::jsonb)`, [row.id, JSON.stringify({customerId:row.customer_id,currentServiceExtensionDays:currentTotal,recordedPaidExtensionDays:oldPaidDays})]);
    oldPaidDays = 0;
  }

  const baseDays = currentTotal - oldPaidDays;
  let cursor = addFixedDays(row.current_period_end, baseDays);
  let paidDays = 0;

  for (const event of events) {
    const metadata = safeObject(event.metadata);
    let nextApplied = 0;
    if (paidEventActive(event)) {
      const nextEnd = projectedEnd(cursor, metadata, event.days);
      nextApplied = wholeDaysBetween(cursor, nextEnd);
      cursor = nextEnd;
      paidDays += nextApplied;
    }
    if (appliedDaysFromMetadata(event) !== nextApplied || Number(metadata.appliedDays) !== nextApplied) {
      const nextMetadata = { ...metadata, appliedDays:nextApplied };
      await client.query('UPDATE subscription_service_extension_events SET metadata=$2::jsonb WHERE id=$1', [event.id, JSON.stringify(nextMetadata)]);
      event.metadata = nextMetadata;
    }
  }

  const total = baseDays + paidDays;
  if (total > 3650) {
    const error = new Error('This purchase would exceed the 3,650-day service-extension safety limit.');
    error.code = 'SUBSCRIPTION_EXTENSION_LIMIT';
    throw error;
  }
  if (total !== currentTotal) {
    const updated = await client.query('UPDATE subscriptions SET service_extension_days=$2,updated_at=NOW() WHERE id=$1 RETURNING *', [row.id, total]);
    Object.assign(row, updated.rows[0] || {}, { subscription_id:row.id, plan_id:row.plan_id });
  }
  return { row, serviceExtensionDays:total, accessExpiresAt:cursor, baseDays, paidDays };
}

async function recompute(subscriptionId) {
  return transaction(client => recomputeForSubscriptionTx(client, subscriptionId));
}

async function currentChoiceRow(customerId, subscriptionId, planCode) {
  return transaction(async client => {
    const row = assertExtendableSubscription(
      await loadSubscriptionTx(client, subscriptionId, customerId),
      { planCode }
    );
    await recomputeForSubscriptionTx(client, row.id);
    return assertExtendableSubscription(await loadSubscriptionTx(client, row.id, customerId), { planCode });
  });
}

async function providerEnabledForBase(planId, planPriceId, provider) {
  if (provider === 'plisio') return true;
  const result = await query(`
    SELECT 1
    FROM plan_provider_prices
    WHERE plan_id=$1 AND plan_price_id=$2 AND provider=$3 AND active=TRUE
    LIMIT 1
  `, [planId, planPriceId, provider]);
  return Boolean(result.rowCount);
}

async function providerEnabledForVariant(variantId, provider) {
  if (provider === 'plisio') return true;
  const result = await query(`
    SELECT 1
    FROM plan_access_variant_provider_prices
    WHERE access_variant_id=$1 AND provider=$2 AND active=TRUE
    LIMIT 1
  `, [variantId, provider]);
  return Boolean(result.rowCount);
}

async function checkoutChoice({ customerId, subscriptionId, planCode, provider, currency = null }) {
  const providerName = String(provider || '').trim().toLowerCase();
  if (!['stripe','paypal','plisio'].includes(providerName)) throw new Error('Unsupported extension payment provider.');
  if (!UUID_RE.test(String(subscriptionId || ''))) throw new Error('A valid current subscription is required for an extension.');

  const row = await currentChoiceRow(customerId, subscriptionId, planCode);
  const wantedCurrency = planPricing.cleanCurrency(currency || await planPricing.platformDefaultCurrency(), 'GBP');
  const price = await planPricing.resolvePrice(row.plan_id, wantedCurrency, { allowFallback:false });
  if (!price || Number(price.price_minor || 0) <= 0) throw new Error(`This plan is not configured for an extension in ${wantedCurrency}.`);

  const access = subscriptionAccessQuantity(row, row);
  const baseQuantity = baseAccessQuantity(row);
  let extensionPlan = {
    ...row,
    id:row.plan_id,
    code:row.plan_code,
    name:row.plan_name,
    plan_price_id:price.id,
    price_minor:Number(price.price_minor),
    currency:String(price.currency).toUpperCase(),
    checkout_mode:'payment',
    external_id:null,
    provider_mapping_id:null,
    access_variant_id:null,
    variant_kind:access.kind,
    access_quantity:access.quantity,
    quantity:access.quantity,
    streams:access.kind === 'streams' ? access.quantity : Math.max(1, Number(row.streams || 1)),
    stremio_household_network_limit:access.kind === 'households' ? access.quantity : Math.max(1, Number(row.stremio_household_network_limit || 1))
  };

  if (access.quantity !== baseQuantity) {
    const variant = (await query(`
      SELECT id,variant_kind,quantity,price_minor,currency
      FROM plan_access_variants
      WHERE plan_id=$1 AND active=TRUE AND currency=$2 AND variant_kind=$3 AND quantity=$4
      LIMIT 1
    `, [row.plan_id, wantedCurrency, access.kind, access.quantity])).rows[0];
    if (!variant || Number(variant.price_minor || 0) <= 0) throw new Error('The current access allowance is no longer priced for extension.');
    if (!await providerEnabledForVariant(variant.id, providerName)) throw new Error(`This plan is not configured for ${providerName === 'stripe' ? 'Stripe' : providerName === 'paypal' ? 'PayPal' : 'Plisio'} one-time extension checkout.`);
    extensionPlan = {
      ...extensionPlan,
      access_variant_id:variant.id,
      price_minor:Number(variant.price_minor),
      currency:String(variant.currency).toUpperCase()
    };
  } else if (!await providerEnabledForBase(row.plan_id, price.id, providerName)) {
    throw new Error(`This plan is not configured for ${providerName === 'stripe' ? 'Stripe' : providerName === 'paypal' ? 'PayPal' : 'Plisio'} one-time extension checkout.`);
  }

  return {
    mode:'payment',
    planCode:row.plan_code,
    currency:wantedCurrency,
    options:[extensionPlan],
    plan:extensionPlan,
    accessQuantity:access.quantity,
    accessVariantKind:access.kind,
    extensionSubscriptionId:row.id,
    targetSubscription:row
  };
}

async function activatePaidExtension({ customerId, planId, provider, providerPaymentId, commercialSnapshot }) {
  const snapshot = safeObject(commercialSnapshot);
  if (!isExtensionSnapshot(snapshot)) throw new Error('Paid extension activation requires an extension checkout contract.');
  if (snapshot.checkoutMode !== 'payment') throw new Error('Subscription extensions must use one-time payment checkout.');
  const targetId = String(snapshot.extensionSubscriptionId || '');
  if (!UUID_RE.test(targetId)) throw new Error('Extension checkout contract is missing its target subscription.');
  const reference = String(providerPaymentId || '').trim();
  if (!reference) throw new Error('Extension payment reference is required.');
  const source = eventSource(provider);

  return transaction(async client => {
    await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [customerId]);
    let target = assertExtendableSubscription(await loadSubscriptionTx(client, targetId, customerId), { planId });
    if (String(snapshot.planId || '') !== String(target.plan_id)) throw new Error('Extension checkout plan does not match the target subscription.');

    const collision = await client.query(`
      SELECT id,customer_id
      FROM subscriptions
      WHERE source=$1 AND provider_subscription_id=$2
      LIMIT 1
      FOR SHARE
    `, [String(provider).toLowerCase(), reference]);
    if (collision.rowCount) {
      throw new Error('This provider payment is already attached to a subscription and cannot also be used as an extension.');
    }

    const existing = (await client.query(`
      SELECT *
      FROM subscription_service_extension_events
      WHERE source=$1 AND reference_id=$2
      LIMIT 1
      FOR UPDATE
    `, [source, reference])).rows[0];
    if (existing) {
      if (String(existing.customer_id) !== String(customerId) || String(existing.subscription_id) !== targetId) {
        const error = new Error('Extension payment identity is already bound to a different customer or subscription.');
        error.code = 'SUBSCRIPTION_EXTENSION_PAYMENT_IDENTITY_CONFLICT';
        throw error;
      }
      const recomputed = await recomputeForSubscriptionTx(client, targetId);
      return { subscription:recomputed.row, event:existing, alreadyApplied:true, accessExpiresAt:recomputed.accessExpiresAt };
    }

    const before = await recomputeForSubscriptionTx(client, targetId);
    target = before.row;
    const priorEnd = before.accessExpiresAt;
    const nextEnd = projectedEnd(priorEnd, snapshot, target.duration_days_snapshot || target.duration_days || 30);
    const initialDays = wholeDaysBetween(priorEnd, nextEnd);
    if (Number(target.service_extension_days || 0) + initialDays > 3650) {
      const error = new Error('This purchase would exceed the 3,650-day service-extension safety limit.');
      error.code = 'SUBSCRIPTION_EXTENSION_LIMIT';
      throw error;
    }

    const metadata = {
      extensionKind:'customer_plan_purchase',
      provider:String(provider).toLowerCase(),
      planId:String(target.plan_id),
      planCode:snapshot.planCode || target.plan_code,
      planName:snapshot.planName || target.plan_name,
      billingInterval:snapshot.billingInterval || target.billing_interval_snapshot || target.billing_interval,
      durationDays:Number(snapshot.durationDays || target.duration_days_snapshot || target.duration_days || 30),
      checkoutIntentId:snapshot.checkoutIntentId || null,
      priceMinor:Number(snapshot.priceMinor || 0),
      discountedMinor:Number(snapshot.discountedMinor ?? snapshot.priceMinor ?? 0),
      currency:String(snapshot.currency || target.currency_snapshot || target.currency || '').toUpperCase(),
      appliedDays:0,
      refunded:false
    };
    const inserted = await client.query(`
      INSERT INTO subscription_service_extension_events(
        subscription_id,customer_id,source,days,reference_id,metadata
      ) VALUES($1,$2,$3,$4,$5,$6::jsonb)
      RETURNING *
    `, [targetId, customerId, source, eventDaysForAudit(initialDays), reference, JSON.stringify(metadata)]);

    const recomputed = await recomputeForSubscriptionTx(client, targetId);
    await client.query(`
      INSERT INTO audit_log(action,entity_type,entity_id,metadata)
      VALUES('payment.subscription.extend','subscription',$1,$2::jsonb)
    `, [targetId, JSON.stringify({
      customerId,
      provider:String(provider).toLowerCase(),
      providerPaymentId:reference,
      planId:String(target.plan_id),
      planCode:metadata.planCode,
      billingInterval:metadata.billingInterval,
      durationDays:metadata.durationDays,
      addedDays:recomputed.serviceExtensionDays - Number(before.row.service_extension_days || 0),
      previousAccessExpiresAt:priorEnd.toISOString(),
      accessExpiresAt:recomputed.accessExpiresAt.toISOString(),
      checkoutIntentId:metadata.checkoutIntentId
    })]);
    return { subscription:recomputed.row, event:inserted.rows[0], alreadyApplied:false, accessExpiresAt:recomputed.accessExpiresAt };
  });
}

async function identityForProviderPayment(provider, providerPaymentId) {
  const source = eventSource(provider), reference = String(providerPaymentId || '').trim();
  if (!reference) return null;
  const result = await query(`
    SELECT DISTINCT customer_id
    FROM subscription_service_extension_events
    WHERE source=$1 AND reference_id=$2
    LIMIT 2
  `, [source, reference]);
  if (result.rowCount !== 1) return null;
  return { scope:'direct', customerId:result.rows[0].customer_id };
}

async function revokeProviderPayment({ customerId, provider, providerPaymentId, reason = '', incidentId = null }) {
  const source = eventSource(provider), reference = String(providerPaymentId || '').trim();
  if (!reference) return { changed:false, subscriptionId:null };
  return transaction(async client => {
    const event = (await client.query(`
      SELECT *
      FROM subscription_service_extension_events
      WHERE source=$1 AND reference_id=$2 AND customer_id=$3
      LIMIT 1
      FOR UPDATE
    `, [source, reference, customerId])).rows[0];
    if (!event) return { changed:false, subscriptionId:null };
    const metadata = safeObject(event.metadata);
    if (metadata.refunded === true) {
      return { changed:false, subscriptionId:event.subscription_id, alreadyRevoked:true };
    }
    await loadSubscriptionTx(client, event.subscription_id, customerId);
    const nextMetadata = {
      ...metadata,
      refunded:true,
      revokedAt:new Date().toISOString(),
      revocationReason:String(reason || 'Provider payment reversed').slice(0,500),
      incidentId:incidentId || null
    };
    await client.query('UPDATE subscription_service_extension_events SET metadata=$2::jsonb WHERE id=$1', [event.id, JSON.stringify(nextMetadata)]);
    const recomputed = await recomputeForSubscriptionTx(client, event.subscription_id);
    await client.query(`
      INSERT INTO audit_log(action,entity_type,entity_id,metadata)
      VALUES('payment.subscription_extension.revoke','subscription',$1,$2::jsonb)
    `, [event.subscription_id, JSON.stringify({
      customerId,
      provider:String(provider).toLowerCase(),
      providerPaymentId:reference,
      incidentId:incidentId || null,
      reason:String(reason || '').slice(0,500),
      accessExpiresAt:recomputed.accessExpiresAt.toISOString()
    })]);
    return { changed:true, subscriptionId:event.subscription_id, accessExpiresAt:recomputed.accessExpiresAt };
  });
}

module.exports = {
  PURCHASE_KIND,
  EVENT_SOURCE_PREFIX,
  UUID_RE,
  safeObject,
  isExtensionSnapshot,
  eventSource,
  accessKind,
  baseAccessQuantity,
  subscriptionAccessQuantity,
  wholeDaysBetween,
  eventDaysForAudit,
  projectedEnd,
  appliedDaysFromMetadata,
  assertExtendableSubscription,
  recomputeForSubscriptionTx,
  recompute,
  checkoutChoice,
  activatePaidExtension,
  identityForProviderPayment,
  revokeProviderPayment
};
