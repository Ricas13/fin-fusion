'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const manual = fs.readFileSync(path.join(root, 'src/platform/admin-manual-entitlement.js'), 'utf8');
const manualOwner = fs.readFileSync(path.join(root, 'src/entitlements/manual-subscriptions.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'src/platform/admin-route-composition.js'), 'utf8');
const customerActions = fs.readFileSync(path.join(root, 'src/platform/admin-actions.js'), 'utf8');
const clientScript = fs.readFileSync(path.join(root, 'public/js/admin-manual-entitlement.js'), 'utf8');

assert(customerActions.includes("INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)"), 'Add customer subscription insert contract must remain present');
assert(manualOwner.includes('INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)'), 'canonical manual subscription owner must retain the subscription INSERT');
assert(manual.includes("require('../entitlements/manual-subscriptions')"), 'manual grant must delegate subscription creation to the canonical entitlement owner');
assert(manual.includes('manualSubscriptions.createManualSubscriptionTx'), 'manual grant must use the canonical transactional manual-subscription primitive');
assert(!manual.includes('INSERT INTO subscriptions'), 'admin route must not own subscription INSERT SQL');
assert(manual.includes("auditAction: 'admin.customer.manual_grant'"), 'manual grants must be audit logged');
assert(manual.includes('await provisioning.reconcileCustomer(customerId);'), 'manual grants must reconcile customer access after commit');
assert(manual.includes('reconciled: false') && manual.includes('service reconciliation still needs attention'), 'a post-commit reconciliation failure must not falsely report that the grant itself failed');
assert(manual.includes('chargedProvider: false') && manual.includes('renewal: false') && manual.includes('providerLinked: false'), 'audit metadata must record non-provider, non-renewing semantics');
assert(!manual.includes('payment_events'), 'manual grants must not fabricate payment_events');
assert(!manual.includes("require('../payments/stripe')") && !manual.includes("require('../payments/paypal')"), 'manual grants must not call provider adapters');
assert(manual.includes("method === 'stripe' && /^sub_") && manual.includes("method === 'paypal' && /^I-"), 'Stripe/PayPal-looking references may be recognized for audit clarity');
assert(!manual.includes('provider_subscription_id'), 'manual grant must keep external provider references audit-only and never enroll them into recurring provider state');
assert(manual.includes('does not charge the provider'), 'operator confirmation must explicitly say the provider is not charged');
assert(manual.includes('recurring-provider link') && manual.includes('audit record only'), 'UI must explain that manual references never create recurring provider linkage');
assert(manual.includes('<script src="/js/admin-manual-entitlement.js" defer></script>'), 'manual form behavior must use an external CSP-safe script');
assert(!manual.includes('<script>(function'), 'manual entitlement UI must not introduce inline JavaScript');
assert(clientScript.includes("plan.addEventListener('change'") && clientScript.includes("start.addEventListener('change'"), 'external script must preserve plan-duration defaults');
assert(manual.includes("surface === 'access' || surface === 'billing'"), 'manual grant form must appear on both Customer 360 Billing and Access');
assert(manual.includes("surface !== 'overview'") && manual.includes("'overview' : null"), 'Customer 360 overview must still participate in the empty-account guard without rendering a second grant form');
assert(manual.includes('currentPrimarySubscription') && manual.includes('if (!existing)'), 'manual grant form must only appear when there is no effective primary subscription');
assert(manual.includes('o.permanent_access=TRUE') && manual.includes('service_extension_days'), 'permanent and extension-backed effective access must block duplicate first-entitlement grants');
assert(manual.includes('Use Manual entitlement edit instead.'), 'server-side guard must redirect existing subscriptions to the normal manual edit flow');
assert(manual.includes("value=\"plan_change\"") && manual.includes('Manual entitlement edit'), 'empty-account renderer must explicitly remove the plan_change action');
assert(routes.includes('createAdminManualEntitlementRouter'), 'manual entitlement router must be part of canonical admin composition');
assert(routes.indexOf('app.use(createAdminManualEntitlementRouter());') < routes.indexOf("mountCritical('customer360', createAdminCustomer360Router())"), 'manual entitlement injection must mount before Customer 360');

console.log('admin manual entitlement smoke: ok');
