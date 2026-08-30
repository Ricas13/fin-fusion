'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(file) { return fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); }

async function main() {
  const lifecycle = read('src/payments/lifecycle-primitives.js');
  assert(lifecycle.includes("processing_started_at=CASE WHEN $3::text IS NULL THEN NULL ELSE NOW() END"), 'failed payment events must retain a retry timestamp');
  assert(!lifecycle.includes("processing_error IS NOT NULL AND processing_token IS NULL\n                 AND (processing_started_at IS NULL OR"), 'failed payment events must not be immediately claimable when their retry timestamp is absent');
  assert(lifecycle.includes('PAYMENT_EVENT_RETRY_MINUTES, PAYMENT_EVENT_LEASE_MINUTES'), 'webhook redelivery must distinguish retry cooldown from active lease timeout');

  const incidents = read('src/payments/incidents.js');
  assert(!incidents.includes("if(!inserted.rowCount)return{duplicate:true}"), 'duplicate payment incidents must not skip access side-effect recovery');
  assert(incidents.includes("incident.scope==='unresolved'&&resolvedIdentity.scope!=='unresolved'"), 'incident replay must upgrade newly resolved customer identity');
  assert(incidents.includes("effectiveAction==='suspend'"), 'duplicate incident replay must re-drive idempotent suspension');
  assert(incidents.includes("effectiveAction==='restore'"), 'duplicate incident replay must re-drive idempotent restoration');

  const providerOps = require('../src/payments/provider-operations');
  const operationSource = read('src/payments/provider-operations.js');
  const recoverySource = read('src/payments/provider-operation-recovery.js');
  assert.equal(typeof providerOps.withRecoveryClaim, 'function');
  assert.equal(typeof providerOps.leaseLost, 'function');
  assert(operationSource.includes('attempt_count=$5') || operationSource.includes('attempt_count=$3'), 'provider-operation state writes must be fenced by claim generation');
  assert(recoverySource.includes('providerOps.withRecoveryClaim(op'), 'recovery worker must establish the claim-generation context');
  assert(recoverySource.includes('providerOperationLeaseLost'), 'stale recovery workers must be discarded rather than overwrite newer state');

  const stripeSource = read('src/payments/stripe.js');
  assert(stripeSource.includes('idempotencyKey:`captainfin-customer-${String(customerId)}`'), 'Stripe customer creation must have a stable idempotency key');
  assert(stripeSource.includes('starting_after:startingAfter'), 'renewal service-credit lookup must paginate invoice items');
  assert(stripeSource.includes("if(!items?.has_more"), 'invoice-item lookup must exhaust provider pagination before declaring the adjustment absent');

  const stripe = require('../src/payments/stripe');
  let calls = 0;
  const firstId = 'ii_first';
  const mockStripe = { invoiceItems: { list: async params => {
    calls += 1;
    if (calls === 1) {
      assert.equal(params.starting_after, undefined);
      return { data: [{ id:firstId, metadata:{} }], has_more:true };
    }
    assert.equal(params.starting_after, firstId);
    return { data: [{ id:'ii_target', amount:-250, metadata:{ captainfin_service_credit_reservation_id:'reservation-1' } }], has_more:false };
  } } };
  const item = await stripe.serviceCreditInvoiceItem(mockStripe, 'in_many_items', 'reservation-1');
  assert.equal(item.id, 'ii_target', 'service-credit recovery must find adjustments beyond the first 100 invoice items');
  assert.equal(calls, 2);

  const referralSource = read('src/referrals.js');
  const paidQuerySlice = referralSource.slice(referralSource.indexOf('const paid=await client.query'), referralSource.indexOf('const qualifying=', referralSource.indexOf('const paid=await client.query')));
  assert(!paidQuerySlice.includes('superseded_by IS NULL'), 'affiliate first-payment selection must not discard a superseded first purchase');
  assert(paidQuerySlice.includes("'cancelled','expired'"), 'affiliate first-payment selection must retain historical settled purchases');
  assert(!paidQuerySlice.includes("s.status='active'"), 'affiliate first-payment selection must not require the first purchase to still be active');

  const paypalSource = read('src/payments/paypal.js');
  assert(!paypalSource.includes("checkout-intent completion failed (access already granted)"), 'PayPal checkout-intent completion failures must propagate to payment-event retry');
  assert(!paypalSource.includes('PayPal plan-change resolution deferred:'), 'PayPal plan-change completion failures must propagate to payment-event retry');
  assert(paypalSource.includes("await checkoutIntents.completeVerifiedProvider('paypal',subscription.id,'completed');await resolveRecordedPlanChange"), 'PayPal recurring activation must finish durable checkout and plan-change bookkeeping before webhook completion');

  const reconciliationSource = read('src/payments/provider-payment-reconciliation.js');
  assert(reconciliationSource.includes('MAX_STRIPE_PAGES'), 'Stripe reconciliation must have bounded pagination');
  assert(reconciliationSource.includes('starting_after: startingAfter'), 'Stripe reconciliation must paginate charges');
  assert(reconciliationSource.includes('truncated = true'), 'bounded Stripe reconciliation must surface truncation');
  assert(!reconciliationSource.includes("|| local.subscriptions.find(item => row.customerId && row.planId"), 'same-customer/plan similarity must never count as provider identity');

  const reconciliation = require('../src/payments/provider-payment-reconciliation');
  const mismatch = reconciliation.localMatch(
    { provider:'stripe',id:'ch_missing',referenceId:'pi_missing',customerId:'customer-a',planId:'plan-a' },
    {
      intents:[],events:[],
      subscriptions:[{ id:'sub-local',customer_id:'customer-a',plan_id:'plan-a',provider_subscription_id:'pi_different' }]
    }
  );
  assert.equal(mismatch.subscription, null, 'provider reconciliation must not hide an unmatched transaction behind a same-customer/plan subscription');
  assert.match(mismatch.reason, /provider reference does not match/i);
  assert.equal(mismatch.severity, 'bad');

  // Post-#443 commercial invariant regression coverage.
  const billingPeriods = require('../src/payments/billing-periods');
  assert.equal(billingPeriods.addPlanDuration({billing_interval:'month'}, new Date('2026-01-31T12:00:00Z')).toISOString(), '2026-02-28T12:00:00.000Z', 'monthly billing must use calendar months');
  assert.equal(billingPeriods.addPlanDuration({billing_interval:'6_months'}, new Date('2026-08-31T12:00:00Z')).toISOString(), '2027-02-28T12:00:00.000Z', 'six-month billing must use calendar months');
  const expirySource = read('src/entitlements/plan-expiry.js');
  assert(expirySource.includes("['month','6_months','year'].includes(interval)"), 'manual/local plan expiry must share calendar billing semantics');

  assert(lifecycle.includes("await resolveCapacitySettlementIncident({ provider, checkoutIntentId: settlementCheckoutIntentId }, client)"), 'paid checkout fulfillment incident resolution must be in the activation transaction');
  assert(!lifecycle.includes("SAVEPOINT discount_redemption"), 'discount accounting divergence must not be swallowed behind a savepoint');
  const discountSource = read('src/payments/discounts.js');
  assert(discountSource.includes("error.code='DISCOUNT_REDEMPTION_DIVERGENCE'"), 'discount divergence must fail closed with a durable error class');

  const affiliateSource = read('src/affiliate-credits.js');
  assert(affiliateSource.includes('UNION SELECT currency FROM affiliate_credit_renewal_reservations'), 'service-credit balance currencies must include renewal reservations');
  assert(affiliateSource.includes("state IN('reserved','provider_applied')"), 'displayed service-credit spendable balance must subtract provider-applied renewal reservations');
  assert(affiliateSource.includes('effective_stremio_entitlements') && affiliateSource.includes('serviceScope.overlaps'), 'service-credit redemption must reject only overlapping service contracts, not unrelated active service');
  assert(affiliateSource.includes('billingPeriods.addPlanDuration(plan,starts)'), 'service-credit activation must use calendar billing periods');

  assert(incidents.includes("incident.access_action==='suspend'") && incidents.includes('reappliedSuspension'), 'reopening a suspensive incident must restore its payment-risk hold');

  assert(stripeSource.includes('captainfin-discount-coupon-${String(discount.id)}'), 'Stripe stored discount coupon creation must be idempotent');
  assert(stripeSource.includes('captainfin-checkout-adjustment-'), 'Stripe checkout adjustment coupon creation must be idempotent');
  const incidentContextSlice = stripeSource.slice(stripeSource.indexOf('async function incidentContextForCharge'), stripeSource.indexOf('async function reverseReferralForDirectIdentity'));
  assert(!incidentContextSlice.includes('catch(_)'), 'Stripe incident identity lookup failures must propagate into webhook retry');
  const disputeSlice = stripeSource.slice(stripeSource.indexOf('async function recordStripeDispute'), stripeSource.indexOf('async function handleWebhookEvent'));
  assert(!disputeSlice.includes('catch(_)'), 'Stripe dispute charge lookup failures must propagate into webhook retry');

  assert(paypalSource.includes('async function paypalRefundContext'), 'PayPal refund handling must verify the originating sale');
  assert(paypalSource.includes('cumulativeRefundMinor') && paypalSource.includes('fullRefund:ctx.fullRefund'), 'PayPal refund incidents must carry cumulative/full-refund evidence');

  // Multi-service plan-change ownership must follow the target service instead of LIMIT 1 Jellyfin ownership.
  const planChangeSource = read('src/payments/customer-plan-change.js');
  assert(planChangeSource.includes('effectiveStremioSubscription(customerId,{includeBlocked:true})'), 'plan changes must inspect the Stremio entitlement lane');
  assert(planChangeSource.includes('effectiveAddons(customerId,{includeBlocked:true})'), 'plan changes must inspect recurring add-ons');
  assert(planChangeSource.includes('serviceScope.overlaps(row,target)'), 'plan changes must choose a recurring subscription by target service overlap');
  assert(planChangeSource.includes('current=await currentRecurring(customerId,target)'), 'plan-change requests must pass the target contract into ownership selection');

  const entitlement = require('../src/entitlements/subscription-state');
  const planChange = require('../src/payments/customer-plan-change');
  const originalEntitlementFns = {
    effectiveSubscription:entitlement.effectiveSubscription,
    effectiveStremioSubscription:entitlement.effectiveStremioSubscription,
    effectiveAddons:entitlement.effectiveAddons
  };
  try {
    entitlement.effectiveSubscription = async () => ({ subscription_id:'j-sub',id:'j-sub',source:'stripe',provider_subscription_id:'sub_jellyfin',is_addon:false,is_free_tier:false,service_type:'jellyfin' });
    entitlement.effectiveStremioSubscription = async () => ({ subscription_id:'s-sub',id:'s-sub',source:'paypal',provider_subscription_id:'I-STREMIO',is_addon:false,is_free_tier:false,service_type:'stremio' });
    entitlement.effectiveAddons = async () => [];
    const stremioCurrent = await planChange.currentRecurring('customer-a',{id:'stremio-target',is_addon:false,service_type:'stremio'});
    assert.equal(stremioCurrent.subscription_id,'s-sub','a Stremio plan change must not mutate an unrelated Jellyfin billing agreement');
    const jellyfinCurrent = await planChange.currentRecurring('customer-a',{id:'jellyfin-target',is_addon:false,service_type:'jellyfin'});
    assert.equal(jellyfinCurrent.subscription_id,'j-sub','a Jellyfin plan change must retain the Jellyfin recurring agreement');
  } finally {
    Object.assign(entitlement,originalEntitlementFns);
  }

  console.log('post-441 ten-bug smoke: ok');
}

main().catch(error => { console.error(error.stack || error); process.exit(1); });
