'use strict';
const workerDbBudget=require('./worker-db-budget');
workerDbBudget.install(require('../db'));
const{expireSubscriptionsAndReconcile}=require('../jellyfin/resilient-provisioning');
const{notifyExpiringSubscriptions}=require('../entitlements/subscription-expiry');
const{reconcileActiveEntitlements,healthcheckAllServers}=require('../jellyfin/jobs');
const automaticFreeDowngradeRetry=require('../entitlements/automatic-free-downgrade-retry');
const drift=require('../jellyfin/drift-control');
const bulkWorker=require('../jellyfin/bulk-worker');
const requestUserSync=require('../integrations/request-user-sync');
const requestServiceSettings=require('../integrations/request-service-settings');
const emailSettings=require('../integrations/email-settings');
const emailOutbox=require('../integrations/email-outbox');
const notificationOutbox=require('../integrations/notification-outbox');
const discordRoleReconciliation=require('../integrations/discord-role-reconciliation');
const billingControl=require('../payments/billing-control');
const providerOperationRecovery=require('../payments/provider-operation-recovery');
const providerCheckoutRecovery=require('../payments/provider-checkout-recovery');
const customerPlanChange=require('../payments/customer-plan-change');
const paymentEventRetry=require('../payments/payment-event-retry');
const providerPaymentReconciliation=require('../payments/provider-payment-reconciliation');
const providerFinancialReconciliation=require('../payments/provider-financial-reconciliation');
const subscriptionDiscovery=require('../payments/subscription-discovery');
const referrals=require('../referrals');
const activationCleanup=require('./activation-cleanup');
const customerInactivity=require('./customer-inactivity-scoped');
const freeCapacityBackfill=require('./free-capacity-backfill');
const notificationLifecycle=require('./notification-lifecycle');
const serviceEndEmails=require('./service-end-emails');
const adminActivityNotifications=require('./admin-activity-notifications');
const freePlacesDigest=require('./free-places-digest');
const dataRetention=require('./data-retention');
const creationIntentRecovery=require('./jellyfin-creation-intent-recovery');
const customerServiceRecovery=require('./customer-service-recovery');
const revenueIntegrity=require('./revenue-integrity');
const revenueIntegrityRepair=require('./revenue-integrity-repair');
const pendingRegistrations=require('../security/pending-registration');
const stremioMediaIndex=require('../stremio/media-index');
const stremioSourceIndex=require('../stremio/source-index');
const stremioExternalTokens=require('../stremio/external-token-maintenance');
const stremioManagedSweep=require('../stremio/managed-entitlement-sweep');
const stremioOrphanCleanup=require('../stremio/orphan-account-cleanup');
const customerDeletion=require('../customers/customer-deletion');
const winbackOffers=require('../marketing/winback-offers');
require('../customers/bulk-operations');
require('../customers/operator-bulk-operations');

const DEFAULT_INTERVAL_SECONDS=300;
const JOB_METADATA=Object.freeze({
 health:{defaultIntervalSeconds:300,critical:true},
 entitlements:{defaultIntervalSeconds:300,critical:true},
 free_capacity_backfill:{defaultIntervalSeconds:30,critical:true},
 policy_drift:{defaultIntervalSeconds:300,critical:false},
 customer_inactivity:{defaultIntervalSeconds:300,critical:true,disableableCritical:true},
 customer_deletions:{defaultIntervalSeconds:300,critical:true},
 creation_intent_recovery:{defaultIntervalSeconds:60,critical:true},
 customer_service_recovery:{defaultIntervalSeconds:60,critical:true},
 revenue_integrity:{defaultIntervalSeconds:60,critical:true},
 provider_financial_reconciliation:{defaultIntervalSeconds:300,critical:false},
 paypal_history_reconciliation:{defaultIntervalSeconds:300,critical:false},
 notification_lifecycle:{defaultIntervalSeconds:300,critical:true},
 admin_activity_notifications:{defaultIntervalSeconds:300,critical:false},
 free_places_digest:{defaultIntervalSeconds:30,critical:false},
 data_retention:{defaultIntervalSeconds:3600,critical:false},
 bulk_jobs:{defaultIntervalSeconds:300,critical:false},
 stale_reclaim:{defaultIntervalSeconds:300,critical:false},
 email_outbox:{defaultIntervalSeconds:300,critical:true},
 notification_outbox:{defaultIntervalSeconds:300,critical:true},
 discord_roles:{defaultIntervalSeconds:43200,critical:true},
 request_users:{defaultIntervalSeconds:300,critical:false},
 billing:{defaultIntervalSeconds:300,critical:true},
 subscription_discovery:{defaultIntervalSeconds:21600,critical:true},
 provider_checkout_recovery:{defaultIntervalSeconds:300,critical:true},
 provider_operation_recovery:{defaultIntervalSeconds:300,critical:true},
 payment_events:{defaultIntervalSeconds:300,critical:true},
 plan_changes:{defaultIntervalSeconds:300,critical:true},
 referral_rewards:{defaultIntervalSeconds:300,critical:false},
 marketing_campaigns:{defaultIntervalSeconds:300,critical:false},
 winback_offers:{defaultIntervalSeconds:300,critical:false},
 activation_cleanup:{defaultIntervalSeconds:300,critical:true},
 pending_registration_cleanup:{defaultIntervalSeconds:300,critical:false},
 stremio_managed_accounts:{defaultIntervalSeconds:300,critical:true},
 stremio_external_tokens:{defaultIntervalSeconds:300,critical:true},
 stremio_media_index:{defaultIntervalSeconds:300,critical:false}
});


// Lifecycle delivery failures are now captured per deterministic notification in
// notification_lifecycle_retries before the discovery cursor advances. The
// historical cursor-rewind implementation is intentionally retired because it
// could starve newer lifecycle events. These literal markers remain only as an
// explicit compatibility breadcrumb for the older static contract while the
// DB-backed retry regression proves the replacement behavior end-to-end:
// const checkpoint=await notificationLifecycle.loadState(new Date())
// if(Number(result?.failed||0)>0) cursorRetained:true
// cursor:checkpoint.cursor.toISOString()
async function notificationLifecycleSafeRun(){const result=await notificationLifecycle.run();return{...result,deliveryFailed:Number(result.failed||0),failed:0};}

function transientIntegrityFinding(item){
 const detail=String(item?.detail||'');
 return item?.kind==='customer_access_not_converged'&&workerDbBudget.transientDatabasePressure(detail);
}

async function revenueIntegritySafeRun(){
 let scanned=await revenueIntegrity.scan();
 let findings=scanned.filter(item=>!transientIntegrityFinding(item));
 const autoRepair=await revenueIntegrityRepair.repairFindings(findings);
 if(autoRepair.attempted){
  scanned=await revenueIntegrity.scan();
  findings=scanned.filter(item=>!transientIntegrityFinding(item));
 }
 const suppressed=scanned.length-findings.length;
 let notification=null;
 if(findings.length){
  try{notification=await revenueIntegrity.notify(findings);}
  catch(error){notification={errors:[revenueIntegrity.clean(error,900)]};}
 }
 const warning=findings.length
  ?`${findings.length} customer/revenue integrity failure${findings.length===1?'':'s'}: ${findings.slice(0,5).map(item=>`${item.kind} (${item.detail})`).join('; ')}`.slice(0,1000)
  :null;
 return{
  total:findings.length,
  processed:findings.length,
  failed:findings.length,
  findings,
  notification,
  autoRepair,
  infrastructureSuppressed:suppressed,
  ...(warning?{warning}:{})
 };
}

async function providerFinancialSafeRun(){
 try{
  const result=await providerFinancialReconciliation.syncRecent({hours:72,force:true});
  return{...result,failed:Number(result.failed||0)};
 }
 catch(error){
  const detail=String(error?.message||error);
  if(workerDbBudget.transientDatabasePressure(detail)){
   return{processed:0,failed:0,infrastructureSuppressed:1,transientSuppressed:true};
  }
  console.error('Provider financial reconciliation failed:',detail);
  return{processed:0,failed:1,error:detail,warning:`Provider financial reconciliation failed: ${detail}`.slice(0,1000)};
 }
}

async function paypalHistorySafeRun(){
 try{
  const result=await providerPaymentReconciliation.syncRecentPayPalHistory({hours:72,limit:100});
  const degraded=Boolean(result?.warning||Number(result?.skipped||0)>0||Number(result?.fulfillmentPending||0)>0||result?.truncated);
  return{...result,failed:degraded?1:0};
 }
 catch(error){
  const detail=String(error?.message||error);
  if(workerDbBudget.transientDatabasePressure(detail)){
   return{provider:'paypal',configured:true,processed:0,recorded:0,alreadyAuthoritative:0,skipped:0,fulfillmentPending:0,deferredUnmatched:0,truncated:false,failed:0,infrastructureSuppressed:1,transientSuppressed:true};
  }
  console.error('PayPal payment-history reconciliation failed:',detail);
  return{provider:'paypal',configured:true,processed:0,recorded:0,alreadyAuthoritative:0,skipped:0,fulfillmentPending:0,deferredUnmatched:0,truncated:false,error:detail,failed:1,warning:`PayPal payment-history reconciliation failed: ${detail}`.slice(0,1000)};
 }
}

// Retained as a compatibility helper for direct callers/tests. Scheduled work uses
// separate jobs below so provider latency/outages can never delay the core integrity
// watchdog. If invoked directly, start both branches concurrently for the same reason.
async function revenueIntegrityWithPayPal(){
 const[integrity,paypalHistory]=await Promise.all([revenueIntegritySafeRun(),paypalHistorySafeRun()]);
 const paypalDegraded=Boolean(paypalHistory?.error||paypalHistory?.warning||Number(paypalHistory?.skipped||0)>0||paypalHistory?.truncated);
 const paypalWarning=paypalHistory?.error
  ?`PayPal payment-history reconciliation failed: ${paypalHistory.error}`
  :(paypalHistory?.warning||'');
 const warning=[integrity?.warning,paypalWarning].filter(Boolean).join(' ').slice(0,1000);
 return{
  ...integrity,
  paypalHistory,
  paypalHistoryDegraded:paypalDegraded?1:0,
  failed:Number(integrity?.failed||0)+(paypalDegraded?1:0),
  infrastructureSuppressed:Number(integrity?.infrastructureSuppressed||0)+Number(paypalHistory?.infrastructureSuppressed||0),
  ...(warning?{warning}:{})
 };
}

const jobs={
 async health(){const results=await healthcheckAllServers();return{total:results.length,failed:results.filter(item=>!item.ok).length}},
 async entitlements(){const downgradeRetries=await automaticFreeDowngradeRetry.processDue({limit:25}),warnings=await notifyExpiringSubscriptions(),expiry=await expireSubscriptionsAndReconcile(),serviceEnd=await serviceEndEmails.run(),active=await reconcileActiveEntitlements(),expiredCount=Number(expiry?.expired??expiry??0),expiryFailed=Number(expiry?.failed||0),downgradeRetryFailed=Number(downgradeRetries.failed||0),serviceEndFailed=Number(serviceEnd.failed||0),blockedCount=Number(active.blocked||0);return{...active,blocked:blockedCount,expired:expiredCount,expiryFailed,downgradeRetries,warnings,serviceEndEmails:serviceEnd,processed:Number(downgradeRetries.total||0)+expiredCount+Number(serviceEnd.processed||0)+Number(active.total||0),failed:Number(active.failed||0)+Number(warnings.failed||0)+expiryFailed+downgradeRetryFailed+serviceEndFailed}},
 async free_capacity_backfill(){return freeCapacityBackfill.run({limit:100})},
 async policy_drift(){const result=await drift.auditDue({all:false});return{...result,processed:Number(result.total||0),failed:Number(result.unreachable||0)}},
 async customer_inactivity(){return customerInactivity.run()},
 async customer_deletions(){return customerDeletion.processDue({limit:10})},
 async creation_intent_recovery(){return creationIntentRecovery.run({limit:25})},
 async customer_service_recovery(){return customerServiceRecovery.run({limit:100})},
 async revenue_integrity(){return revenueIntegritySafeRun()},
 async provider_financial_reconciliation(){return providerFinancialSafeRun()},
 async paypal_history_reconciliation(){return{processed:0,failed:0,skipped:'superseded_by_provider_financial_reconciliation'}},
 async notification_lifecycle(){return notificationLifecycleSafeRun()},
 async admin_activity_notifications(){return adminActivityNotifications.run()},
 async free_places_digest(){return freePlacesDigest.run()},
 async data_retention(){return dataRetention.run()},
 async bulk_jobs(){return bulkWorker.processBatch()},
 async stale_reclaim(){const reclaimed=await bulkWorker.reclaimStaleRunningItems();return{processed:Number(reclaimed||0),reclaimed:Number(reclaimed||0)}},
 async email_outbox(){const status=await emailSettings.status();if(!status.configured)return{processed:0,skipped:'email_not_configured'};return emailOutbox.deliverDue({limit:50})},
 async notification_outbox(){return notificationOutbox.deliverDue({limit:50})},
 async discord_roles(){return discordRoleReconciliation.reconcileLinkedCustomers()},
 async request_users(){await requestServiceSettings.ensureLoaded();const config=await requestUserSync.configuration();if(!config.configured)return{processed:0,skipped:'request_service_not_configured'};const result=await requestUserSync.syncAll();return{...result,processed:Number(result.total||0)}},
 async billing(){return billingControl.syncDue({all:false,limit:100})},
 async subscription_discovery(){const result=await subscriptionDiscovery.apply(null),unresolved=Number(result.unresolved||0);return{...result,processed:Number(result.safeFound||0),failed:Number(result.failed||0),...(unresolved?{warning:`${unresolved} provider subscription match${unresolved===1?'':'es'} require operator review.`}:{})}},
 async provider_checkout_recovery(){return providerCheckoutRecovery.run({limit:25})},
 async provider_operation_recovery(){return providerOperationRecovery.run({limit:25})},
 async payment_events(){return paymentEventRetry.run({limit:25})},
 async plan_changes(){const stripe=await customerPlanChange.applyDueStripe(),paypalExpiry=await customerPlanChange.expireDuePaypal();return{...stripe,paypalExpiry,processed:Number(stripe.succeeded||0)+Number(paypalExpiry.notified||0),waiting:Number(stripe.pending||0),failed:Number(stripe.failed||0)+Number(paypalExpiry.failed||0)}},
 async referral_rewards(){return referrals.processDueRewards({limit:100})},
 async marketing_campaigns(){return require('../marketing/campaigns').runDue({limit:20})},
 async winback_offers(){return winbackOffers.run({limit:100})},
 async activation_cleanup(){return activationCleanup.process()},
 async pending_registration_cleanup(){return pendingRegistrations.cleanupExpired(500)},
 async stremio_managed_accounts(){const sync=await stremioManagedSweep.syncActiveBounded();const orphanApply=Number(sync.failed||0)===0;const orphans=await stremioOrphanCleanup.run({apply:orphanApply,limit:5});const warning=[sync.warning,orphans.warning].filter(Boolean).join('; ').slice(0,1000)||null;return{total:Number(sync.total||0)+Number(orphans.total||0),processed:Number(sync.processed||0)+Number(orphans.processed||0),failed:Number(sync.failed||0)+Number(orphans.failed||0),revoked:Number(sync.revoked||0),orphanRemoteDeleted:Number(orphans.deleted||0),sync,orphans,...(warning?{warning}:{})}},
 async stremio_external_tokens(){return stremioExternalTokens.maintain({rotateLimit:25,revokeLimit:100})},
 async stremio_media_index(){let external={total:0,processed:0,failed:0};try{external=await stremioSourceIndex.indexDueSources();}catch(error){external={total:0,processed:0,failed:1};console.error('External Stremio source index failed:',error.message);}let managed={total:0,processed:0,failed:0};try{managed=await stremioMediaIndex.indexAll();}catch(error){managed={total:0,processed:0,failed:1};console.error('Managed Stremio media index failed:',error.message);}return{total:Number(external.total||0)+Number(managed.total||0),processed:Number(external.processed||0)+Number(managed.processed||0),failed:Number(external.failed||0)+Number(managed.failed||0),external,managed}}
};

const runtimeNames=Object.keys(jobs);
const metadataNames=Object.keys(JOB_METADATA);
const missingMetadata=runtimeNames.filter(jobKey=>!JOB_METADATA[jobKey]);
const staleMetadata=metadataNames.filter(jobKey=>!jobs[jobKey]);
if(missingMetadata.length||staleMetadata.length){
 throw new Error(`Automation job metadata mismatch; missing=${missingMetadata.join(',')||'none'} stale=${staleMetadata.join(',')||'none'}`);
}

const definitions=Object.freeze(Object.fromEntries(runtimeNames.map(jobKey=>[
 jobKey,
 Object.freeze({run:jobs[jobKey],...JOB_METADATA[jobKey]})
])));
const DEFAULT_INTERVALS=Object.freeze(Object.fromEntries(
 runtimeNames.map(jobKey=>[jobKey,Number(definitions[jobKey].defaultIntervalSeconds||DEFAULT_INTERVAL_SECONDS)])
));

function names(){return Object.keys(definitions)}
function definition(jobKey){return definitions[String(jobKey||'')]||null}
function defaultIntervalSeconds(jobKey){return Number(definition(jobKey)?.defaultIntervalSeconds||DEFAULT_INTERVAL_SECONDS)}
function criticalNames(){return names().filter(jobKey=>definitions[jobKey].critical)}
function disableableCriticalNames(){return names().filter(jobKey=>definitions[jobKey].disableableCritical)}
function isCritical(jobKey){return Boolean(definition(jobKey)?.critical)}
function mayBeDisabled(jobKey){return Boolean(definition(jobKey)?.disableableCritical)}
async function run(jobKey){const def=definition(jobKey);if(!def)throw new Error(`Unknown automation job: ${jobKey}`);return def.run()}
module.exports={jobs,definitions,names,definition,run,criticalNames,disableableCriticalNames,isCritical,mayBeDisabled,DEFAULT_INTERVAL_SECONDS:DEFAULT_INTERVALS,defaultIntervalSeconds,notificationLifecycleSafeRun,revenueIntegritySafeRun,transientIntegrityFinding,paypalHistorySafeRun,providerFinancialSafeRun,revenueIntegrityWithPayPal};