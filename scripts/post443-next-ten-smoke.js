'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(file) { return fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); }

async function main() {
  const discounts = read('src/payments/discounts.js');
  assert(discounts.includes("error.code='DISCOUNT_REDEMPTION_DIVERGENCE'"), 'discount redemption divergence must fail closed');
  assert(!discounts.includes('granting access anyway'), 'paid discount accounting must not silently grant access when redemption bookkeeping diverges');

  const lifecycle = read('src/payments/lifecycle-primitives.js');
  assert(lifecycle.includes('resolveCapacitySettlementIncident({ provider, checkoutIntentId: settlementCheckoutIntentId }, client)'), 'capacity incident resolution must commit atomically with recovered activation');
  assert(!lifecycle.includes('Capacity settlement incident resolution deferred:'), 'successful settlement must not leave incident closure as best-effort follow-up');

  const incidents = read('src/payments/incidents.js');
  const reopenSlice = incidents.slice(incidents.indexOf('async function reopen('), incidents.indexOf('async function notes('));
  assert(reopenSlice.includes("incident.access_action==='suspend'"), 'reopening a suspending incident must restore the suspension invariant');
  assert(reopenSlice.includes('applyHold('), 'reopening a suspending incident must reapply its payment-risk hold');

  const credits = read('src/affiliate-credits.js');
  assert(credits.includes("affiliate_credit_renewal_reservations r WHERE r.customer_id=$1"), 'displayed spendable service credit must subtract renewal reservations');
  assert(credits.includes("r.state IN('reserved','provider_applied')"), 'provider-applied renewal reservations must remain unavailable to spend');
  assert(credits.includes('serviceScope.overlaps(row,plan)'), 'service-credit redemption must block only overlapping service entitlements');
  assert(credits.includes('billingPeriods.addPlanDuration(plan,starts)'), 'service-credit subscription expiry must use canonical calendar periods');

  const expiry = require('../src/entitlements/plan-expiry');
  const jan31 = new Date('2024-01-31T12:00:00.000Z');
  assert.equal(expiry.endForPlan({ billing_interval:'month', duration_days:30 }, { now:jan31 }).toISOString(), '2024-02-29T12:00:00.000Z', 'monthly billing must preserve calendar-month semantics across February');
  assert.equal(expiry.endForPlan({ billing_interval:'year', duration_days:365 }, { now:new Date('2024-02-29T12:00:00.000Z') }).toISOString(), '2025-02-28T12:00:00.000Z', 'yearly billing must clamp leap-day renewals safely');

  const stripe = read('src/payments/stripe.js');
  assert(stripe.includes('captainfin-discount-coupon-${String(discount.id)}'), 'persisted Stripe discount coupons must use stable provider idempotency');
  assert(stripe.includes('captainfin-checkout-adjustment-${String(idempotencyKey)}'), 'temporary checkout adjustment coupons must use checkout-scoped idempotency');
  const identitySlice = stripe.slice(stripe.indexOf('async function incidentContextForCharge'), stripe.indexOf('async function reverseReferralForDirectIdentity'));
  assert(!identitySlice.includes('catch(_)'), 'Stripe incident identity lookups must propagate provider failures into webhook retry');
  const disputeSlice = stripe.slice(stripe.indexOf('async function recordStripeDispute'), stripe.indexOf('async function handleWebhookEvent'));
  assert(!disputeSlice.includes('catch(_)'), 'Stripe dispute charge lookup must not silently convert provider failure into unresolved identity');

  const paypal = read('src/payments/paypal.js');
  assert(paypal.includes('async function paypalRefundContext'), 'PayPal refund handling must verify original/cumulative refund state');
  assert(paypal.includes('fullRefund:ctx.fullRefund'), 'PayPal refund incidents must carry verified full-refund state into policy');
  assert(!paypal.includes('metadata:{saleId:resource.sale_id||resource.id,fullRefund:false}'), 'PayPal refund policy must not hard-code every refund as partial');

  const planChangeSource = read('src/payments/customer-plan-change.js');
  assert(planChangeSource.includes('effectiveStremioSubscription(customerId,{includeBlocked:true})'), 'plan-change ownership must inspect the Stremio lane');
  assert(planChangeSource.includes('effectiveAddons(customerId,{includeBlocked:true})'), 'plan-change ownership must inspect recurring add-ons');
  assert(planChangeSource.includes('serviceScope.overlaps(row,target)'), 'plan-change ownership must match the target service scope');
  assert(planChangeSource.includes('current=await currentRecurring(customerId,target)'), 'plan-change requests must resolve the source subscription against the target plan');

  const entitlement = require('../src/entitlements/subscription-state');
  const planChange = require('../src/payments/customer-plan-change');
  const originals = {
    effectiveSubscription: entitlement.effectiveSubscription,
    effectiveStremioSubscription: entitlement.effectiveStremioSubscription,
    effectiveAddons: entitlement.effectiveAddons
  };
  try {
    entitlement.effectiveSubscription = async () => ({ subscription_id:'j-sub', id:'j-sub', source:'stripe', provider_subscription_id:'sub_jellyfin', is_addon:false, is_free_tier:false, service_type:'jellyfin' });
    entitlement.effectiveStremioSubscription = async () => ({ subscription_id:'s-sub', id:'s-sub', source:'paypal', provider_subscription_id:'I-STREMIO', is_addon:false, is_free_tier:false, service_type:'stremio' });
    entitlement.effectiveAddons = async () => [];
    const stremio = await planChange.currentRecurring('customer-1', { id:'target-stremio', is_addon:false, service_type:'stremio' });
    assert.equal(stremio.subscription_id, 's-sub', 'Stremio plan change must not mutate the customer\'s unrelated Jellyfin subscription');
    const jellyfin = await planChange.currentRecurring('customer-1', { id:'target-jellyfin', is_addon:false, service_type:'jellyfin' });
    assert.equal(jellyfin.subscription_id, 'j-sub', 'Jellyfin plan change must keep ownership of the Jellyfin recurring subscription');
  } finally {
    Object.assign(entitlement, originals);
  }

  console.log('post-443 next-ten commercial smoke: ok');
}

main().catch(error => { console.error(error.stack || error); process.exit(1); });
