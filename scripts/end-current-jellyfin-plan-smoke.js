'use strict';

const assert=require('assert');
const fs=require('fs');
const termination=require('../src/payments/subscription-termination');

const ui=fs.readFileSync('src/platform/admin-bulk-customers.js','utf8');
const bulk=fs.readFileSync('src/platform/bulk-operations.js','utf8');
const providerRecovery=fs.readFileSync('src/payments/provider-operation-recovery.js','utf8');
const permanent=fs.readFileSync('src/entitlements/permanent-access.js','utf8');
const terminationSource=fs.readFileSync('src/payments/subscription-termination.js','utf8');
const stateSource=fs.readFileSync('src/entitlements/subscription-state.js','utf8');

assert(ui.includes("['end_jellyfin_plan','End current Jellyfin plan',{highImpact:true,fields:['reason'],confirmWord:'END'}]"),'admin action must be high-impact, require a reason, and use explicit END confirmation');
assert(ui.includes("action==='end_jellyfin_plan'&&!row.plan_id"),'preview must exclude customers without a current plan');
assert(ui.includes("action==='end_jellyfin_plan'&&!['jellyfin','bundle'].includes(service)"),'preview must reject Stremio-only primary plans');
assert(ui.includes('Recurring Stripe/PayPal billing is cancelled and verified'),'operator warning must say provider billing is terminated and verified');
assert(ui.includes("A bundle\\'s bundled Stremio access also ends"),'operator warning must disclose bundle impact');

assert(bulk.includes("registerHandler('end_jellyfin_plan'"),'bulk worker must own the new mutation');
assert(bulk.includes('subscriptionTermination.currentJellyfinSubscription(item.customer_id)'),'handler must resolve only the current effective Jellyfin/bundle entitlement');
assert(bulk.includes('planChange.cancelPendingChange(item.customer_id,null)'),'open plan changes tied to the ended subscription must be cancelled first');
assert(bulk.includes('subscriptionTermination.terminateRecurringNow'),'provider-managed recurring plans must use durable provider termination');
assert(bulk.includes('subscriptionTermination.terminateLocal'),'manual/local plans must end through the canonical local termination owner');
assert(bulk.includes('await provisioning.reconcileCustomer(item.customer_id)'),'access must be reconciled after the plan ends');
assert(bulk.includes('bulk-end-jellyfin:${item.id}'),'bulk item identity must provide a stable retry key');

assert(terminationSource.includes("operationType:OPERATION_TYPE"),'provider termination must be recorded as a provider operation');
assert(terminationSource.includes("const OPERATION_TYPE='subscription_terminate'"),'provider operation type must be stable');
assert(terminationSource.includes('billingControl.terminateRecurringForDeletion'),'termination must reuse the verified Stripe/PayPal cancellation adapter rather than bypass it');
assert(terminationSource.includes('subscriptionState.effectiveSubscription(customerId,{includeBlocked:true})'),'current Jellyfin termination must use the service-scoped entitlement owner rather than an arbitrary primary view row');
assert(stateSource.includes("IN ('jellyfin','bundle')"),'the canonical primary entitlement resolver must explicitly scope Jellyfin/bundle services');
assert(terminationSource.includes('providerOps.providerApplied'),'provider success must be durable before local convergence');
assert(terminationSource.includes('providerOps.localApplied'),'local convergence must be durable');
assert(terminationSource.includes('providerOps.reconciled'),'completed provider termination must close the operation');
assert(terminationSource.includes("status='cancelled'"),'local subscription must become cancelled');
assert(terminationSource.includes('service_extension_days=0'),'ending now must clear service extensions');
assert(terminationSource.includes('current_period_end=LEAST'),'ending now must close the paid-through entitlement immediately');
assert(terminationSource.includes('permanentAccess.revokeInTransaction'),'permanent-access pins must be revoked in the same local transaction');
assert(permanent.includes('revokeInTransaction'),'permanent access must expose a transaction-safe canonical revoke owner');
assert(providerRecovery.includes("const TERMINATION_OPERATION_TYPES = ['subscription_terminate']"),'provider recovery must own unresolved terminations');
assert(providerRecovery.includes("require('./subscription-termination').recoverProviderOperation(op)"),'automatic provider recovery must converge termination operations');

assert.throws(()=>termination.assertJellyfinPrimary({is_addon:true,effective_service_type:'jellyfin'}),/Add-on subscriptions cannot be ended/);
assert.throws(()=>termination.assertJellyfinPrimary({is_addon:false,effective_service_type:'stremio'}),/does not provide current Jellyfin access/);
assert.strictEqual(termination.serviceType({service_type_snapshot:'bundle'}),'bundle');

console.log('end current jellyfin plan smoke: ok');