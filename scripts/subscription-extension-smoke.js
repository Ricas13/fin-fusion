'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const billingPeriods = require('../src/payments/billing-periods');
const extensions = require('../src/payments/subscription-extensions');

const oct9 = new Date('2026-10-09T12:34:56.000Z');
assert.equal(
  billingPeriods.addPlanDuration({ billing_interval:'month',duration_days:30 }, oct9).toISOString(),
  '2026-11-09T12:34:56.000Z',
  'monthly extension must add one calendar month from the existing paid-through boundary'
);
assert.equal(
  extensions.wholeDaysBetween(oct9, new Date('2026-11-09T12:34:56.000Z')),
  31,
  'October-to-November monthly extension must record the exact 31-day service span'
);
const jan31 = new Date('2028-01-31T08:00:00.000Z');
assert.equal(
  extensions.projectedEnd(jan31,{billingInterval:'month',durationDays:30}).toISOString(),
  '2028-02-29T08:00:00.000Z',
  'calendar-month extension must clip safely at a leap-year month end'
);
const leapYear = new Date('2028-02-29T08:00:00.000Z');
assert.equal(
  extensions.wholeDaysBetween(leapYear, extensions.projectedEnd(leapYear,{billingInterval:'year',durationDays:365})),
  365,
  'calendar-year extension must be measured from the exact existing boundary'
);
const leapSpanningYear = new Date('2027-03-01T08:00:00.000Z');
const leapSpanningDays = extensions.wholeDaysBetween(
  leapSpanningYear,
  extensions.projectedEnd(leapSpanningYear,{billingInterval:'year',durationDays:365})
);
assert.equal(leapSpanningDays,366,'calendar-year extension spanning leap day must keep all 366 service days');
assert.equal(extensions.eventDaysForAudit(leapSpanningDays),365,'legacy audit-row day cap must not require a live schema migration; exact applied duration stays in metadata');
assert(extensions.isExtensionSnapshot({
  kind:'direct_plan',
  purchaseKind:'subscription_extension',
  extensionSubscriptionId:'00000000-0000-4000-8000-000000000001'
}), 'extension checkout contract must be distinguishable from a new plan purchase');

const dashboard = fs.readFileSync(path.join(__dirname,'..','views','customer','dashboard.ejs'),'utf8');
const flexible = fs.readFileSync(path.join(__dirname,'..','src','platform','flexible-checkout.js'),'utf8');
const intents = fs.readFileSync(path.join(__dirname,'..','src','payments','checkout-intents.js'),'utf8');
const capacity = fs.readFileSync(path.join(__dirname,'..','src','entitlements','plan-capacity.js'),'utf8');
const stripe = fs.readFileSync(path.join(__dirname,'..','src','payments','stripe.js'),'utf8');
const paypal = fs.readFileSync(path.join(__dirname,'..','src','payments','paypal.js'),'utf8');
const lifecycle = fs.readFileSync(path.join(__dirname,'..','src','payments','lifecycle.js'),'utf8');
const primitives = fs.readFileSync(path.join(__dirname,'..','src','payments','lifecycle-primitives.js'),'utf8');

assert(dashboard.includes('extensionSubscriptionId'), 'current-plan card must submit the exact subscription being extended');
assert(dashboard.includes('Extend by'), 'current-plan card must expose extension checkout actions');
assert(dashboard.includes('checkoutMode" value="payment"'), 'same-plan extension must always be one-time checkout');
assert(flexible.includes("purchaseKind:'subscription_extension',extensionSubscriptionId"), 'checkout contract must freeze extension intent');
assert(flexible.includes('subscriptionExtensions.checkoutChoice'), 'extension checkout must use its capacity-neutral resolver');
assert(intents.includes("snapshot.purchaseKind !== 'subscription_extension'"), 'extension checkout intent must skip acquisition capacity reservation');
assert(capacity.includes("subscription_extension"), 'capacity accounting must ignore extension-only checkout intents');
assert(stripe.includes('incidentResult?.extensionPaymentLoss')&&paypal.includes('incidentResult?.extensionPaymentLoss'),'extension-only refunds must not unwind the customer\'s original affiliate qualifying reward');
assert(
  paypal.includes('activateCompletedOrder') && paypal.includes('verifiedProviderContract') && paypal.includes('recordCompletedCapture'),
  'PayPal extension checkout must retain canonical verified capture settlement/accounting while recurring-payment ledger reconciliation evolves independently'
);
assert(
  paypal.indexOf('await recordCompletedCapture(capture') < paypal.indexOf('const activated=await lifecycle.activatePurchase', paypal.indexOf('async function activateCompletedOrder')),
  'verified PayPal capture money must be ledgered before local extension fulfillment so paid-but-unfulfilled checkouts remain automatically recoverable'
);
assert(
  lifecycle.includes('Paid extension fulfillment incident could not be recorded') &&
  lifecycle.includes('recordCapacitySettlementIncident') &&
  lifecycle.includes('resolveCapacitySettlementIncident'),
  'a provider-paid extension that cannot be fulfilled locally must enter the durable checkout-completion incident path and clear it after a successful retry'
);
assert(
  primitives.includes('extension_target_changed_after_provider_settlement') &&
  primitives.includes('extension_target_blocked_after_provider_settlement'),
  'paid-but-unfulfilled extension incidents must explain stale/blocked target failures instead of being mislabeled as capacity exhaustion'
);


assert(require('fs').readFileSync(require('path').join(__dirname,'..','src/payments/customer-plan-change.js'),'utf8').includes('This subscription has prepaid extension time remaining.'),'plan changes must not convert prepaid extension time into a different plan/currency/access allowance');
console.log('subscription extension smoke: ok — calendar duration, one-time checkout, capacity neutrality and extension-only refund accounting');
