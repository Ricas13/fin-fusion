'use strict';

const core=require('./provisioning-core');
const {query,transaction}=require('../db');
const subscriptionState=require('../entitlements/subscription-state');
const accessHolds=require('../entitlements/access-holds');
const inactivityHoldReconciliation=require('../entitlements/inactivity-hold-reconciliation');
function safeLog(value,max=500){return String(value==null?'':value).replace(/[\r\n\t\u2028\u2029]+/g,' ').slice(0,max)}
async function currentEntitlement(customerId){return subscriptionState.effectiveSubscription(customerId)}
async function syncAccess(customerId){await accessHolds.syncLegacySummary(customerId)}
async function markPasswordSetupRequired(accountId){if(!accountId)return;await query(`UPDATE jellyfin_accounts SET password_setup_required=TRUE,password_reset_required=TRUE,updated_at=NOW() WHERE id=$1`,[accountId]);}
async function notifyNewJellyfinAccess(customerId,account){
  try{
    const notifications=require('../integrations/notification-dispatch');
    const runtimeSettings=require('../platform/runtime-settings');
    await runtimeSettings.ensureLoaded().catch(()=>{});
    const found=await query(`SELECT COALESCE(c.email,u.email) email,COALESCE(c.display_name,u.username,'Customer') customer_name,cp.phone_e164,cp.whatsapp_opt_in FROM customers c LEFT JOIN app_users u ON u.id=c.user_id LEFT JOIN customer_communication_preferences cp ON cp.customer_id=c.id WHERE c.id=$1`,[customerId]);
    if(!found.rowCount)return;
    const row=found.rows[0],site=runtimeSettings.siteName(),serverUrl=String(account.public_url||'').trim(),username=account.jellyfin_username||'your Jellyfin username';
    const steps=account.password_setup_required
      ? `Your Jellyfin access has been created. Sign in to your ${site} portal first, open Jellyfin access and choose your Jellyfin password. Then open the server${serverUrl?` at ${serverUrl}`:''} and sign in as ${username}. Start any title to confirm playback.`
      : `Your Jellyfin access has been created. Open the server${serverUrl?` at ${serverUrl}`:''}, sign in as ${username}, and start any title to confirm playback. The same instructions are shown in your ${site} portal.`;
    await notifications.dispatch({eventType:'customer.service.provisioned',to:row.email||null,subject:`Your ${site} Jellyfin access is ready`,text:steps,whatsappTo:row.whatsapp_opt_in?row.phone_e164:null,dedupeKey:`jellyfin-provisioned:${account.id}`,forceEmail:true});
    const admin=String(process.env.ADMIN_NOTIFICATION_EMAIL||'').trim();
    if(admin)await notifications.dispatch({eventType:'customer.service.provisioned',to:admin,subject:`${site}: Jellyfin access provisioned`,text:`${row.customer_name} (${row.email||customerId}) was provisioned as ${username}${serverUrl?` on ${serverUrl}`:''}.`,dedupeKey:`admin-jellyfin-provisioned:${account.id}`,forceEmail:true});
  }catch(error){console.warn('Jellyfin onboarding notification failed.',{customerId:safeLog(customerId,100),error:safeLog(error?.message||error)});}
}
async function reconcileCustomer(customerId){
  // A plan-specific inactivity hold belongs only to the free plan that created
  // it. Release it before policy calculation if the customer has since moved
  // to a different/free-disabled/paid entitlement. Manual and cleanup holds are
  // deliberately untouched here.
  await inactivityHoldReconciliation.releaseObsoleteForCustomer(customerId);
  await syncAccess(customerId);
  // Detect only accounts created by this reconciliation. Existing/imported
  // Jellyfin users keep their current credential state, while a newly-created
  // account whose bootstrap password is random is immediately flagged for the
  // customer to choose a real password in the portal.
  const before=await query(`SELECT id FROM jellyfin_accounts WHERE customer_id=$1`,[customerId]);
  const existing=new Set(before.rows.map(r=>String(r.id)));
  const outcome=await core.reconcileCustomer(customerId);
  if(outcome?.account?.id&&!existing.has(String(outcome.account.id))){
    await markPasswordSetupRequired(outcome.account.id);
    outcome.account.password_setup_required=true;
    outcome.account.password_reset_required=true;
    notifyNewJellyfinAccess(customerId,outcome.account).catch(()=>{});
  }
  return outcome;
}
async function reconcileAccount(accountId){const account=await query('SELECT customer_id FROM jellyfin_accounts WHERE id=$1',[accountId]);if(account.rowCount)await syncAccess(account.rows[0].customer_id);return core.reconcileAccount(accountId)}
async function createJellyfinAccount(customerId,server,effective,options={}){const account=await core.createJellyfinAccount(customerId,server,effective,options);if(options.passwordSetupRequired!==false){await markPasswordSetupRequired(account.id);account.password_setup_required=true;account.password_reset_required=true;}return account;}
async function setJellyfinPassword(customerId,accountId,newPassword){const result=await core.setJellyfinPassword(customerId,accountId,newPassword);await query(`UPDATE jellyfin_accounts SET password_setup_required=FALSE,password_reset_required=FALSE,updated_at=NOW() WHERE id=$1 AND customer_id=$2`,[accountId,customerId]);return result;}
function adminHoldType(reason){if(reason==='disabled')return'admin_disabled';if(reason==='suspended')return'admin_suspended';return'admin_hold'}
async function holdAccess(customerId,reason='suspended',actorUserId=null){const type=adminHoldType(String(reason||'suspended'));await accessHolds.addHold({customerId,type,sourceKey:'admin',reason:String(reason||type).slice(0,500),actorUserId});return reconcileCustomer(customerId)}
async function releaseAccess(customerId,actorUserId=null){await accessHolds.releaseAllAdminHolds(customerId,actorUserId);return reconcileCustomer(customerId)}
async function maybeAutoDowngrade(customerId){const lifecycle=require('../payments/lifecycle');try{return await lifecycle.autoDowngradeEligibleCustomer(customerId)}catch(error){console.error('Automatic free-tier downgrade failed.',{customerId:safeLog(customerId,100),error:safeLog(error?.message||error)});return null}}
async function expireSubscriptionsAndReconcile(){const expired=await transaction(async client=>{const rows=await client.query(`WITH expired AS (UPDATE subscriptions SET status='expired',service_extension_days=0,updated_at=NOW() WHERE superseded_by IS NULL AND ((status IN('active','trialing','past_due','paused','cancelled') AND current_period_end+(COALESCE(service_extension_days,0)||' days')::interval<=NOW()) OR (status='expired' AND COALESCE(service_extension_days,0)>0 AND current_period_end+(service_extension_days||' days')::interval<=NOW())) RETURNING customer_id,plan_id,source) SELECT DISTINCT e.customer_id,BOOL_OR(p.price_minor>0) AS had_paid_expiry FROM expired e JOIN plans p ON p.id=e.plan_id GROUP BY e.customer_id`);return rows.rows});for(const row of expired){const customerId=row.customer_id;let downgraded=null;if(row.had_paid_expiry)downgraded=await maybeAutoDowngrade(customerId);if(downgraded)continue;try{await reconcileCustomer(customerId)}catch(error){console.error('Entitlement reconcile failed.',{customerId:safeLog(customerId,100),error:safeLog(error?.message||error)})}}return expired.length}
module.exports={...core,currentEntitlement,reconcileCustomer,reconcileAccount,createJellyfinAccount,setJellyfinPassword,holdAccess,releaseAccess,expireSubscriptionsAndReconcile,notifyNewJellyfinAccess};
