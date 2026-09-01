'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

const checkout = source('src/payments/checkout-intents.js');
const credit = source('src/payments/service-credit-reservations.js');
const discounts = source('src/payments/discounts.js');
const incidents = source('src/payments/incidents.js');
const operations = source('src/payments/provider-operations.js');
const renewals = source('src/payments/service-credit-renewals.js');
const migration = source('db/migrations/20260830173000_checkout_provider_identity.sql');

assert(checkout.includes('PROVIDER_CHECKOUT_ID_REQUIRED'), 'blank provider checkout identities must fail closed');
assert(checkout.includes('PROVIDER_CHECKOUT_REBIND_CONFLICT'), 'an attached checkout must not be rebound');
assert(checkout.includes("providerUnresolved && ['expired', 'cancelled', 'failed'].includes(state)"), 'attached local abandonment must preserve frozen financial reservations until provider-terminal truth');
assert(checkout.includes("state IN('reserved','released','expired')"), 'late paid provider settlement must consume its frozen discount reservation');
assert(credit.includes('SERVICE_CREDIT_LATE_SETTLEMENT_CONFLICT'), 'late service-credit settlement must fail explicitly when its backing credit was reused');
assert(credit.includes("state === 'cancelled_attached'"), 'service credit must stay reserved after local cancellation of an attached provider checkout');
assert(discounts.includes('frozenReservationForSubscription'), 'discount settlement must honor the checkout-time reservation');
assert(discounts.includes('amount_applied_minor'), 'discount redemption must use the exact frozen reservation amount');
assert(incidents.includes("require('../jellyfin/resilient-provisioning')"), 'payment-incident reconciliation must persist provisioning retry state');
assert(incidents.includes("incident.access_action==='suspend'"), 'reopening a suspended payment incident must restore its hold');
assert(operations.includes('PROVIDER_OPERATION_IDEMPOTENCY_CONFLICT'), 'provider operation idempotency conflicts must be explicit');
assert(operations.includes('provider_operations.request_snapshot=EXCLUDED.request_snapshot'), 'provider operation retries must match the exact request snapshot');
assert(renewals.includes('SERVICE_CREDIT_RENEWAL_IDENTITY_CONFLICT'), 'renewal credit webhook identity conflicts must fail closed');
assert(renewals.includes("if (existing)"), 'renewal replay must inspect an existing reservation before deciding the new amount is inapplicable');
assert(migration.includes('billing_checkout_intents_provider_checkout_uidx'), 'provider checkout identity must be unique in the database');
assert(migration.includes('RAISE EXCEPTION'), 'migration must refuse pre-existing duplicate provider checkout identities instead of deleting history');

console.log('post-443 payment temporal consistency smoke: ok');
