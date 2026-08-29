'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const manual = fs.readFileSync(path.join(root, 'src/platform/admin-manual-entitlement.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'src/platform/admin-route-composition.js'), 'utf8');
const customerActions = fs.readFileSync(path.join(root, 'src/platform/admin-actions.js'), 'utf8');

assert(manual.includes("VALUES($1,$2,$3,'admin_grant',$4,$5,TRUE,$6)"), 'manual grants must create a local admin_grant subscription with renewal off');
assert(customerActions.includes("INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)"), 'Add customer subscription insert contract must remain present');
assert(manual.includes("INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,cancel_at_period_end,provider_subscription_id)"), 'manual grant must use the existing subscription table path rather than a parallel entitlement product');
assert(manual.includes("'admin.customer.manual_grant'"), 'manual grants must be audit logged');
assert(manual.includes('await provisioning.reconcileCustomer(customerId);'), 'manual grants must reconcile customer access after commit');
assert(manual.includes("chargedProvider: false") && manual.includes("renewal: false"), 'audit metadata must record non-provider, non-renewing semantics');
assert(!manual.includes('payment_events'), 'manual grants must not fabricate payment_events');
assert(!manual.includes("require('../payments/stripe')") && !manual.includes("require('../payments/paypal')"), 'manual grants must not call provider adapters');
assert(manual.includes("method === 'stripe' && /^sub_") && manual.includes("method === 'paypal' && /^I-"), 'only real-looking Stripe/PayPal subscription IDs may attach to the local subscription');
assert(manual.includes("source,starts_at,current_period_end,cancel_at_period_end,provider_subscription_id"), 'provider ID storage must stay on the local subscription record');
assert(manual.includes("source='admin_grant'") === false, 'manual grant must not pretend the source is Stripe or PayPal');
assert(manual.includes('does not charge the provider'), 'operator confirmation must explicitly say the provider is not charged');
assert(manual.includes("req.query.tab === 'billing'") && manual.includes("req.query.tab === 'access'"), 'manual grant surface must appear on both Customer 360 Billing and Access');
assert(manual.includes('currentPrimarySubscription') && manual.includes('if (!existing)'), 'manual grant form must only appear when there is no current primary subscription');
assert(manual.includes('Use Manual entitlement edit instead.'), 'server-side guard must redirect existing subscriptions to the normal manual edit flow');
assert(manual.includes("value=\"plan_change\"") && manual.includes('Manual entitlement edit'), 'empty-account renderer must explicitly remove the plan_change action');
assert(routes.includes("createAdminManualEntitlementRouter"), 'manual entitlement router must be part of canonical admin composition');
assert(routes.indexOf('app.use(createAdminManualEntitlementRouter());') < routes.indexOf('app.use(createAdminCustomer360Router());'), 'manual entitlement injection must mount before Customer 360');

console.log('admin manual entitlement smoke: ok');
