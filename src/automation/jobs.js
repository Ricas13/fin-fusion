'use strict';
const{expireSubscriptionsAndReconcile}=require('../jellyfin/provisioning');
const{reconcileActiveEntitlements,healthcheckAllServers}=require('../jellyfin/jobs');
const drift=require('../jellyfin/drift-control');
const bulkWorker=require('../jellyfin/bulk-worker');
const requestUserSync=require('../integrations/request-user-sync');
const requestServiceSettings=require('../integrations/request-service-settings');
const emailSettings=require('../integrations/email-settings');
const emailOutbox=require('../integrations/email-outbox');
const notificationOutbox=require('../integrations/notification-outbox');
const billingControl=require('../payments/billing-control');
const customerPlanChange=require('../payments/customer-plan-change');
const referrals=require('../referrals');
const activationCleanup=require('./activation-cleanup');
const jellyfinLifecycle=require('./jellyfin-lifecycle');
const pendingRegistrations=require('../security/pending-registration');
const stremioMediaIndex=require('../stremio/media-index');
const stremioSourceIndex=require('../stremio/source-index');
const stremioSourcePool=require('../stremio/source-pool');
const stremioSourceAdmission=require('../stremio/source-admission');
require('../platform/bulk-operations');
require('../platform/operator-bulk-operations');
const jobs={
 async health(){const results=await healthcheckAllServers();return{total:results.length,failed:results.filter(item=>!item.ok).length}},
 async entitlements(){const expired=await expireSubscriptionsAndReconcile(),active=await reconcileActiveEntitlements();return{...active,expired,processed:Number(expired||0)+Number(active.total||0)}},
 async policy_drift(){const result=await drift.auditDue({all:false});return{...result,processed:Number(result.total||0),failed:Number(result.unreachable||0)}},
 async customer_inactivity(){return jellyfinLifecycle.run()},
 async bulk_jobs(){return bulkWorker.processBatch()},
 async stale_reclaim(){const reclaimed=await bulkWorker.reclaimStaleRunningItems();return{processed:Number(reclaimed||0),reclaimed:Number(reclaimed||0)}},
 async email_outbox(){const status=await emailSettings.status();if(!status.configured)return{processed:0,skipped:'email_not_configured'};return emailOutbox.deliverDue({limit:50})},
 async notification_outbox(){return notificationOutbox.deliverDue({limit:50})},
 async request_users(){await requestServiceSettings.ensureLoaded();const config=await requestUserSync.configuration();if(!config.configured)return{processed:0,skipped:'request_service_not_configured'};const result=await requestUserSync.syncAll();return{...result,processed:Number(result.total||0)}},
 async billing(){return billingControl.syncDue({all:false,limit:100})},
 async plan_changes(){return customerPlanChange.applyDueStripe()},
 async referral_rewards(){return referrals.processDueRewards({limit:100})},
 async activation_cleanup(){return activationCleanup.process()},
 async pending_registration_cleanup(){return pendingRegistrations.cleanupExpired(500)},
 async stremio_media_index(){let rotation={total:0,rotated:0,failed:0};try{rotation=await stremioSourcePool.rotateDueTokens({limit:25});}catch(error){rotation={total:0,rotated:0,failed:1};console.error('External Stremio source token rotation failed:',error.message);}let external={total:0,processed:0,failed:0};try{external=await stremioSourceIndex.indexDueSources();}catch(error){external={total:0,processed:0,failed:1};console.error('External Stremio source index failed:',error.message);}let managed={total:0,processed:0,failed:0};try{managed=await stremioMediaIndex.indexAll();}catch(error){managed={total:0,processed:0,failed:1};console.error('Managed Stremio media index failed:',error.message);}const expiredPlaybackLeases=await stremioSourceAdmission.cleanup(5000);return{total:Number(rotation.total||0)+Number(external.total||0)+Number(managed.total||0),processed:Number(rotation.rotated||0)+Number(external.processed||0)+Number(managed.processed||0)+Number(expiredPlaybackLeases||0),failed:Number(rotation.failed||0)+Number(external.failed||0)+Number(managed.failed||0),rotation,external,managed,expiredPlaybackLeases}}
};
function names(){return Object.keys(jobs)}
async function run(jobKey){const job=jobs[jobKey];if(!job)throw new Error(`Unknown automation job: ${jobKey}`);return job()}
module.exports={jobs,names,run};
