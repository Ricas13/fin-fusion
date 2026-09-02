'use strict';
const{query}=require('../db');
const{expireSubscriptionsAndReconcile,notifyExpiringSubscriptions}=require('../jellyfin/resilient-provisioning');
const{reconcileActiveEntitlements,healthcheckAllServers}=require('../jellyfin/jobs');
const drift=require('../jellyfin/drift-control');
const bulkWorker=require('../jellyfin/bulk-worker');
const requestUserSync=require('../integrations/request-user-sync');
const requestServiceSettings=require('../integrations/request-service-settings');
const emailSettings=require('../integrations/email-settings');
const emailOutbox=require('../integrations/email-outbox');
const notificationOutbox=require('../integrations/notification-outbox');
const billingControl=require('../payments/billing-control');
const providerOperationRecovery=require('../payments/provider-operation-recovery');
const customerPlanChange=require('../payments/customer-plan-change');
const paymentEventRetry=require('../payments/payment-event-retry');
const referrals=require('../referrals');
const activationCleanup=require('./activation-cleanup');
const customerInactivity=require('./customer-inactivity-scoped');
const notificationLifecycle=require('./notification-lifecycle');
const adminActivityNotifications=require('./admin-activity-notifications');
const freePlacesDigest=require('./free-places-digest');
const dataRetention=require('./data-retention');
const pendingRegistrations=require('../security/pending-registration');
const stremioMediaIndex=require('../stremio/media-index');
const stremioSourceIndex=require('../stremio/source-index');
const stremioExternalTokens=require('../stremio/external-token-maintenance');
const stremioManagedEntitlements=require('../stremio/managed-entitlements');
const customerDeletion=require('../platform/customer-deletion');
require('../platform/bulk-operations');
require('../platform/operator-bulk-operations');
async function notificationLifecycleSafeRun(){const checkpoint=await notificationLifecycle.loadState(new Date());const result=await notificationLifecycle.run();if(Number(result?.failed||0)>0){await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES($1,$2::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`,[notificationLifecycle.STATE_KEY,JSON.stringify({cursor:checkpoint.cursor.toISOString(),servers:checkpoint.servers})]);return{...result,cursorRetained:true};}return result;}
const jobs={
 async health(){const results=await healthcheckAllServers();return{total:results.length,failed:results.filter(item=>!item.ok).length}},
 async entitlements(){const warnings=await notifyExpiringSubscriptions(),expiry=await expireSubscriptionsAndReconcile(),active=await reconcileActiveEntitlements(),expiredCount=Number(expiry?.expired??expiry??0),expiryFailed=Number(expiry?.failed||0);return{...active,expired:expiredCount,expiryFailed,warnings,processed:expiredCount+Number(active.total||0),failed:Number(active.failed||0)+Number(active.blocked||0)+Number(warnings.failed||0)+expiryFailed}},
 async policy_drift(){const result=await drift.auditDue({all:false});return{...result,processed:Number(result.total||0),failed:Number(result.unreachable||0)}},
 async customer_inactivity(){return customerInactivity.run()},
 async customer_deletions(){return customerDeletion.processDue({limit:10})},
 async notification_lifecycle(){return notificationLifecycleSafeRun()},
 async admin_activity_notifications(){return adminActivityNotifications.run()},
 async free_places_digest(){return freePlacesDigest.run()},
 async data_retention(){return dataRetention.run()},
 async bulk_jobs(){return bulkWorker.processBatch()},
 async stale_reclaim(){const reclaimed=await bulkWorker.reclaimStaleRunningItems();return{processed:Number(reclaimed||0),reclaimed:Number(reclaimed||0)}},
 async email_outbox(){const status=await emailSettings.status();if(!status.configured)return{processed:0,skipped:'email_not_configured'};return emailOutbox.deliverDue({limit:50})},
 async notification_outbox(){return notificationOutbox.deliverDue({limit:50})},
 async request_users(){await requestServiceSettings.ensureLoaded();const config=await requestUserSync.configuration();if(!config.configured)return{processed:0,skipped:'request_service_not_configured'};const result=await requestUserSync.syncAll();return{...result,processed:Number(result.total||0)}},
 async billing(){return billingControl.syncDue({all:false,limit:100})},
 async provider_operation_recovery(){return providerOperationRecovery.run({limit:25})},
 async payment_events(){return paymentEventRetry.run({limit:25})},
 async plan_changes(){const stripe=await customerPlanChange.applyDueStripe(),paypalExpiry=await customerPlanChange.expireDuePaypal();return{...stripe,paypalExpiry,processed:Number(stripe.succeeded||0)+Number(paypalExpiry.notified||0),waiting:Number(stripe.pending||0),failed:Number(stripe.failed||0)+Number(paypalExpiry.failed||0)}},
 async referral_rewards(){return referrals.processDueRewards({limit:100})},
 async marketing_campaigns(){return require('../marketing/campaigns').runDue({limit:20})},
 async activation_cleanup(){return activationCleanup.process()},
 async pending_registration_cleanup(){return pendingRegistrations.cleanupExpired(500)},
 async stremio_managed_accounts(){return stremioManagedEntitlements.syncActive()},
 async stremio_external_tokens(){return stremioExternalTokens.maintain({rotateLimit:25,revokeLimit:100})},
 async stremio_media_index(){let external={total:0,processed:0,failed:0};try{external=await stremioSourceIndex.indexDueSources();}catch(error){external={total:0,processed:0,failed:1};console.error('External Stremio source index failed:',error.message);}let managed={total:0,processed:0,failed:0};try{managed=await stremioMediaIndex.indexAll();}catch(error){managed={total:0,processed:0,failed:1};console.error('Managed Stremio media index failed:',error.message);}return{total:Number(external.total||0)+Number(managed.total||0),processed:Number(external.processed||0)+Number(managed.processed||0),failed:Number(external.failed||0)+Number(managed.failed||0),external,managed}}
};
function names(){return Object.keys(jobs)}
async function run(jobKey){const job=jobs[jobKey];if(!job)throw new Error(`Unknown automation job: ${jobKey}`);return job()}
module.exports={jobs,names,run,notificationLifecycleSafeRun};