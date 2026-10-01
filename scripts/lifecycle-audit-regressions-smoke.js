'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const paypal=require('../src/payments/paypal');
const providerHttp=require('../src/payments/provider-http');
const providerCheckoutRecovery=require('../src/payments/provider-checkout-recovery');
const lifecyclePolicy=require('../src/entitlements/jellyfin-lifecycle-policy');
const automationRegistry=require('../src/automation/jobs');
const criticalJobs=automationRegistry;

const root=path.resolve(__dirname,'..');
const source=file=>fs.readFileSync(path.join(root,file),'utf8');

function paypalPaidThroughCancellation(){
  const future=new Date(Date.now()+10*24*60*60*1000);
  const past=new Date(Date.now()-10*24*60*60*1000);
  const cancelled={status:'CANCELLED',billing_info:{next_billing_time:null}};
  const active={status:'ACTIVE',billing_info:{next_billing_time:future.toISOString()}};

  const preserved=paypal.paidThroughCancellationUpdate({status:'active',billing_mode:'subscription',current_period_end:future,refund_terminated_at:null},cancelled);
  assert.equal(preserved.preserved,true,'PayPal cancellation must preserve already-paid future access');
  assert.equal(preserved.providerStatus,'ACTIVE','preserved PayPal cancellation must remain locally active');
  assert.equal(preserved.cancelAtPeriodEnd,true,'preserved PayPal cancellation must stop renewal');
  assert.equal(new Date(preserved.periodEnd).getTime(),future.getTime(),'paid-through boundary must not be shortened');

  const expired=paypal.paidThroughCancellationUpdate({status:'active',billing_mode:'subscription',current_period_end:past,refund_terminated_at:null},cancelled);
  assert.equal(expired.preserved,false,'PayPal cancellation after the paid-through date must be terminal');
  assert.equal(expired.providerStatus,'CANCELLED');

  const refunded=paypal.paidThroughCancellationUpdate({status:'active',billing_mode:'subscription',current_period_end:future,refund_terminated_at:new Date()},cancelled);
  assert.equal(refunded.preserved,false,'refund termination must override paid-through cancellation preservation');

  const stillActive=paypal.paidThroughCancellationUpdate({status:'active',billing_mode:'subscription',current_period_end:future,refund_terminated_at:null},active);
  assert.equal(stillActive.preserved,false,'normal ACTIVE state must pass through without cancellation rewriting');
  assert.equal(stillActive.providerStatus,'ACTIVE');
}

function legacyPayPalProfileRecovery(){
  const modern='https://api-m.paypal.com/v1/billing/subscriptions/I-LEGACY123';
  const invalidProfile={message:'The profile ID is invalid'};
  const fallback=providerHttp.paypalLegacyFallback(modern,{method:'GET'},400,invalidProfile);
  assert(fallback,'legacy PayPal profiles rejected by the modern read endpoint must receive a compatibility lookup');
  assert.equal(fallback.url,'https://api-m.paypal.com/v1/payments/billing-agreements/I-LEGACY123','legacy PayPal read fallback must use the billing-agreements API');
  assert.equal(providerHttp.paypalLegacyFallback(modern,{method:'GET'},400,{message:'Generic bad request'}),null,'unrelated PayPal HTTP 400 responses must not trigger legacy fallback');
  assert.equal(providerHttp.paypalLegacyFallback(`${modern}/cancel`,{method:'POST',body:'{}'},400,invalidProfile),null,'ambiguous HTTP 400 mutations must never be replayed through the legacy API');
  const historicalCancel=providerHttp.paypalLegacyFallback(`${modern}/cancel`,{method:'POST',body:'{}'},404,{});
  assert(historicalCancel&&historicalCancel.url.endsWith('/v1/payments/billing-agreements/I-LEGACY123/cancel'),'existing 404 legacy cancellation fallback must remain supported');
}

function providerCheckoutRecoveryDiagnostics(){
  const warning=providerCheckoutRecovery.failureWarning([{
    checkoutIntentId:'intent-1',
    provider:'paypal',
    providerCheckoutId:'I-LEGACY123',
    error:'PayPal HTTP 400:\nThe profile ID is invalid'
  }]);
  assert.match(warning,/1 provider checkout recovery failure:/,'checkout recovery failures must expose a useful automation warning');
  assert.match(warning,/paypal I-LEGACY123: PayPal HTTP 400: The profile ID is invalid/,'checkout recovery warning must identify the provider checkout and root error');
  assert(!warning.includes('\n'),'checkout recovery warning must remain log/UI safe on one line');
  assert(warning.length<=1000,'checkout recovery warning must remain bounded');
  assert.match(source('src/payments/provider-checkout-recovery.js'),/if \(summary\.failed\) summary\.warning = failureWarning\(summary\.failures\);/,'checkout recovery run result must publish detailed failure warnings to automation health');
}

function jellyfinDeletionScope(){
  const text=source('src/customers/operator-bulk-operations.js');
  assert.match(text,/jellyfinAdminControl\.remove\(item\.customer_id,null,/,'Jellyfin delete must persist service-scoped removal authority');
  assert.match(text,/deleteJellyfinAccounts\(item\.customer_id,\{[^}]*holdAccess:false/,'Jellyfin delete must not create a customer-wide access hold');
}

function adminAuthorityReconciliationRaceContract(){
  const permanent=source('src/entitlements/permanent-access.js');
  const serviceControl=source('src/entitlements/service-admin-control.js');

  assert.match(permanent,/enable\(customerId[\s\S]*?reconciliationLock\.withCustomerReconciliationLock\(customerId/,
    'Permanent Access grants must serialize with destructive customer reconciliation');
  assert.match(permanent,/revoke\(customerId[\s\S]*?reconciliationLock\.withCustomerReconciliationLock/,
    'Permanent Access revocation must serialize with customer reconciliation');
  assert.match(serviceControl,/setPresent\(customerId[\s\S]*?withCustomerReconciliationLock\(customerId/,
    'administrator-present authority must not race an in-flight reconciliation');
  assert.match(serviceControl,/setRemoved\(customerId[\s\S]*?withCustomerReconciliationLock\(customerId/,
    'administrator-removed authority must not race an in-flight reconciliation');
  assert.match(serviceControl,/clear\(customerId[\s\S]*?withCustomerReconciliationLock\(customerId/,
    'return-to-automatic authority changes must not race an in-flight reconciliation');
  const inactivity=source('src/automation/customer-inactivity-scoped.js');
  assert.match(inactivity,/finalizeDetachedRemovals[\s\S]*?reconciliationLock\.withCustomerReconciliationLock/,
    'detached Free inactivity completion must serialize its authority re-check and terminal plan close');
  assert.match(inactivity,/finalizeDetachedRemovalLocked[\s\S]*?subscriptionState\.liveFreeJellyfinSubscription/,
    'detached Free inactivity completion must re-read current authority while holding the customer lock');
  assert.match(inactivity,/OR public\.subscription_admin_present\(h\.customer_id,'jellyfin',s\.id\)/,
    'a protected detached retry must remain discoverable if account restore succeeded before hold release failed');
}

function freeInactivitySafetyContract(){
  const inactivity=source('src/automation/customer-inactivity.js');
  const scoped=source('src/automation/customer-inactivity-scoped.js');
  const lifecycle=source('src/entitlements/jellyfin-lifecycle-policy.js');
  const adminControl=source('src/jellyfin/admin-control.js');

  assert.match(inactivity,/ph\.jellyfin_account_id=ja\.id[\s\S]*?ph\.jellyfin_account_id IS NULL[\s\S]*?ph\.access_lane_snapshot='free'[\s\S]*?ph\.access_lane_snapshot IS NULL/,'Free inactivity must preserve exact-account and conservative orphan continuity while excluding orphan playback known to belong to the paid lane');
  assert.match(inactivity,/GREATEST\([\s\S]*?fa\.starts_at[\s\S]*?ja\.created_at[\s\S]*?ja\.access_lane_changed_at[\s\S]*?automation_resume\.resumed_at/,'Free allocation must start at the newest real allocation boundary');
  assert.doesNotMatch(inactivity,/historical_first_playback_at|any_playback_history/,'legacy playback heuristics must not decide current allocation state');
  assert.doesNotMatch(inactivity,/noPlaybackDays|noPlaybackEligible/,'Free retention must not have a separate login/activity rule');
  assert.match(inactivity,/LEAST\(COALESCE\(ph\.ended_at,ph\.last_seen_at\),NOW\(\)\)/,'rolling playback must count exact overlap with the rolling window');

  assert.match(lifecycle,/SAFE_UNCONFIGURED\s*=\s*Object\.freeze\(\{\s*enabled:\s*false,\s*dryRun:\s*true\s*\}\)/,'missing lifecycle configuration must fail closed');
  assert.equal(lifecyclePolicy.explicitlyConfigured({}),false,'empty lifecycle settings must not authorize destructive automation');
  assert.equal(lifecyclePolicy.explicitlyConfigured({enabled:true}),false,'partial lifecycle settings must not authorize destructive automation');
  assert.equal(lifecyclePolicy.explicitlyConfigured({enabled:true,dryRun:false}),true,'both execution fields must be explicit before enforcement');

  const removalStart=scoped.indexOf('async function removeEligibleAccount');
  const removalEnd=scoped.indexOf('async function runPlanRules',removalStart);
  const removalBlock=scoped.slice(removalStart,removalEnd);
  assert.match(removalBlock,/await provisioning\.deleteJellyfinAccount\(/,'inactivity must delete the exact selected Free account');
  assert.doesNotMatch(removalBlock,/await provisioning\.reconcileCustomer\(/,'the inactivity delete path must not depend on broad entitlement reconciliation; detached/protected recovery may reconcile separately');
  assert.doesNotMatch(scoped,/refreshServerUserActivity|candidate_user_not_observed_in_fresh_users_response/,'login/user inventory is not retention authority');
  assert.doesNotMatch(scoped,/massRemovalRisk|CIRCUIT_BREAKER_/,'retired mass-removal policy must not remain in runtime');
  assert.match(scoped,/eligible\.slice\(0, MAX_ENFORCEMENTS_PER_RUN\)/,'large cleanups may be throughput-bounded without changing eligibility');

  const pinBranch=adminControl.slice(
    adminControl.indexOf("control.mode==='admin_server_pin'"),
    adminControl.indexOf('return decorated',adminControl.indexOf("control.mode==='admin_server_pin'"))
  );
  assert(!pinBranch.includes('decorated.blocked=false'),'server pinning must remain placement-only and cannot erase inactivity holds');
}
function deferredWebhookContract(){
  const text=source('src/platform/webhooks.js');
  assert.match(text,/result\?\.processingError/,'payment webhooks must inspect durable business-processing failure');
  assert.match(text,/status\(503\)/,'deferred payment webhook must return a retriable HTTP status');
  assert.match(text,/stripe\.processWebhook[\s\S]*deferredPaymentWebhook/,'Stripe must use deferred acknowledgement handling');
  assert.match(text,/paypal\.processWebhook[\s\S]*deferredPaymentWebhook/,'PayPal must use deferred acknowledgement handling');
}

function discoveryAutomationContract(){
  const jobs=source('src/automation/jobs.js');
  assert.match(jobs,/subscriptionDiscovery\.apply\(null\)/,'safe provider subscription discovery must be runnable automatically');
  assert.strictEqual(criticalJobs.isCritical('subscription_discovery'),true,'provider discovery must be lifecycle-critical');
  assert.strictEqual(automationRegistry.defaultIntervalSeconds('subscription_discovery'),21600,'provider discovery must have a bounded recurring cadence');
}

function independentServiceRecoveryContract(){
  const text=source('src/automation/customer-service-recovery.js');
  assert.match(text,/async function recoverCustomer\b/,'customer service recovery must remain independently executable');
  assert.match(text,/const capture\s*=\s*async\s*\(name,\s*fn\)\s*=>/,'service recovery must isolate individual service failures');
  for(const service of ['stremio','emby','discord']){
    assert.match(text,new RegExp(`await capture\\('${service}'`),`${service} must remain independently recoverable`);
  }
  assert.match(text,/failures\.push\(\{\s*service:\s*name,/,'one service failure must be recorded without aborting the remaining service repairs');
}

function obsoleteRenewalIntegrityContract(){
  const text=source('src/automation/revenue-integrity.js');
  assert.match(text,/async function retireObsoleteManualRenewalOperations/,'integrity scan must actively retire obsolete renewal failures');
  assert.match(text,/po\.operation_type IN\('renewal_stop','renewal_resume'\)/,'only renewal-control operations may use automatic stale retirement');
  assert.match(text,/po\.manual_review_required=TRUE/,'only already-escalated provider operations may be auto-retired');
  assert.match(text,/po\.failure_kind='terminal'/,'only terminal historical renewal failures may be auto-retired');
  assert.match(text,/COALESCE\(s\.billing_mode,''\)<>'subscription'/,'a subscription that became manual must make its old recurring operation obsolete');
  assert.match(text,/COALESCE\(s\.source,''\)<>po\.provider/,'a subscription that changed provider identity must make its old recurring operation obsolete');
  assert.match(text,/s\.provider_subscription_id IS DISTINCT FROM po\.request_snapshot->>'providerSubscriptionId'/,'provider subscription replacement must make the old operation obsolete');
  assert.match(text,/failure_kind='superseded'/,'obsolete renewal failures must remain as audit history but stop requiring manual review');
  assert.match(text,/manual_review_required=FALSE/,'superseded renewal failures must leave the active attention set');
  assert.match(text,/await retireObsoleteManualRenewalOperations\(\);[\s\S]*FROM provider_operations[\s\S]*manual_review_required=TRUE/,'stale renewal retirement must happen before integrity findings are read');
}

paypalPaidThroughCancellation();
legacyPayPalProfileRecovery();
providerCheckoutRecoveryDiagnostics();
jellyfinDeletionScope();
adminAuthorityReconciliationRaceContract();
freeInactivitySafetyContract();
deferredWebhookContract();
discoveryAutomationContract();
independentServiceRecoveryContract();
obsoleteRenewalIntegrityContract();
console.log('Lifecycle audit regression smoke passed.');
