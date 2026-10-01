'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const viewV2 = read('src/platform/customer-360-view-v2.js');
const admin360 = read('src/platform/admin-customer-360.js');
const customer360 = read('src/platform/customer-360.js');
const billingControl = read('src/payments/billing-control.js');
const planChange = read('src/payments/customer-plan-change.js');

// Billing tab: provider, period end, renewal on/off, open plan-change,
// last payment incident — facts only, no in-app refund.
assert(viewV2.includes("function billing(d,token,options={})"), 'billing() must accept token and options to render actions and pending-change data');
assert(/renewalRow=s\?`.*Renewal.*pill\(s\.cancel_at_period_end\?'Off':'On'/.test(viewV2), 'billing tab must show renewal on/off derived from cancel_at_period_end');
assert(viewV2.includes("kv('Open plan change'") && viewV2.includes('pending.target_plan_name'), 'billing tab must show the open plan-change target and effective date when one exists');
assert(viewV2.includes('No refunds are issued from this page'), 'billing tab must not offer in-app refunds');
assert(customer360.includes('COALESCE(s.price_minor_snapshot,p.price_minor) price_minor')&&customer360.includes('COALESCE(s.currency_snapshot,p.currency) currency')&&customer360.includes('COALESCE(s.billing_interval_snapshot,p.billing_interval) billing_interval'),'Billing facts must read preserved subscription billing snapshots, not blindly adopt a manually assigned plan\'s commercial defaults');
assert(customer360.includes("p.is_free_tier AND NOT ((s.source='stripe'")&&customer360.includes("s.source='paypal'"),'a recurring provider period end must remain visible even when a manual entitlement edit points access at a free-tier plan');

// Actions must call the existing billing-control/plan-change services
// directly, not new SQL in the view layer.
assert(admin360.includes("/admin/users/:customerId/renewal'") && admin360.includes('billingControl.setCustomerRenewal(req.params.customerId,enabled,req.session.authUserId)'), 'the renewal route must delegate customer subscription selection and provider mutation to billing control');
assert(admin360.includes("/admin/users/:customerId/plan-change/cancel'") && admin360.includes('planChange.cancelPendingChange(req.params.customerId,req.session.authUserId)'), 'the cancel action must call customer-plan-change.cancelPendingChange');
assert(!/UPDATE\s+subscriptions/i.test(admin360.slice(admin360.indexOf("/admin/users/:customerId/renewal'"), admin360.indexOf("/admin/users/:customerId/renewal'") + 800)), 'the renewal route must not write to subscriptions with raw SQL');

// Reused services, confirmed present (not reimplemented).
assert(billingControl.includes('async function setRenewal(subscriptionId, enabled, actorUserId = null'), 'billing-control.js must still export setRenewal with the expected signature');
assert(billingControl.includes('async function setCustomerRenewal(customerId, enabled, actorUserId = null') && billingControl.includes("subscriptionState.effectiveSubscription(customerId, { includeBlocked: true })") && billingControl.includes('return setRenewal(current.subscription_id || current.id, enabled, actorUserId, options)'), 'billing-control.js must own canonical customer renewal subscription selection and delegate the money mutation to setRenewal');
assert(planChange.includes('async function cancelPendingChange(customerId,actorUserId=null)') && planChange.includes('async function pendingForCustomer(customerId)'), 'customer-plan-change.js must still export cancelPendingChange and pendingForCustomer');

console.log('customer billing tab smoke: ok');
