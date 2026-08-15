'use strict';

// Per-item handlers for admin bulk customer operations. High-level business
// mutations deliberately delegate to the same lifecycle services used by the
// single-customer UI; bulk tooling must never become a privileged shortcut
// around provider billing, reseller capacity or entitlement semantics.

const { query, transaction } = require('../db');
const bulkWorker = require('../jellyfin/bulk-worker');
const provisioning = require('../jellyfin/provisioning');
const policy = require('../jellyfin/policy');
const stripe = require('../payments/stripe');
const paypal = require('../payments/paypal');
const lifecycle = require('../payments/lifecycle');
const planChange = require('../payments/customer-plan-change');
const subscriptionState = require('../entitlements/subscription-state');
const monthly = require('../resellers/monthly');

function registerHandler(jobType, fn) { bulkWorker.registerHandler(jobType, fn); }
async function currentSubscription(customerId) {
    const effective=await subscriptionState.effectiveSubscription(customerId,{includeBlocked:true});
    if(effective)return effective;
    const result=await query(`SELECT * FROM subscriptions WHERE customer_id=$1 ORDER BY current_period_end DESC,created_at DESC LIMIT 1`,[customerId]);
    return result.rows[0]||null;
}
async function auditItem(action,customerId,metadata){await query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES($1,'customer',$2,$3::jsonb)`,[action,customerId,JSON.stringify(metadata||{})]);}

async function applyLibraryNames(customerId,names,mode){const plan=await provisioning.currentEntitlement(customerId);if(!plan)throw new Error('Customer has no active plan');const catalog=await provisioning.libraryCatalogForServerClass(plan.server_class),changes=policy.libraryOverridePlan(mode,names,catalog.names);for(const change of changes)await provisioning.setLibraryOverride(customerId,change.name,change.granted,null);await provisioning.reconcileCustomer(customerId);return{libraries:changes.map(c=>c.name)}}
registerHandler('library_add',async item=>{const result=await applyLibraryNames(item.customer_id,item.params?.libraryNames||[],'add');await auditItem('admin.bulk.library_add',item.customer_id,result);return result});
registerHandler('library_remove',async item=>{const result=await applyLibraryNames(item.customer_id,item.params?.libraryNames||[],'remove');await auditItem('admin.bulk.library_remove',item.customer_id,result);return result});
registerHandler('library_replace',async item=>{const result=await applyLibraryNames(item.customer_id,item.params?.libraryNames||[],'replace');await auditItem('admin.bulk.library_replace',item.customer_id,result);return result});
registerHandler('library_reset',async item=>{await provisioning.resetAllLibraryOverrides(item.customer_id);await provisioning.reconcileCustomer(item.customer_id);await auditItem('admin.bulk.library_reset',item.customer_id,{});return{}});

// Provider-backed recurring plans must be changed at the provider as well as
// locally. The shared plan-change service performs immediate Stripe upgrades,
// provider schedules for downgrades and explicit PayPal transition handling.
registerHandler('plan_change',async item=>{
    const planId=String(item.params?.planId||''),planResult=await query(`SELECT * FROM plans WHERE id=$1 AND active=TRUE AND visible=TRUE AND archived_at IS NULL AND (effective_from IS NULL OR effective_from<=NOW()) AND (effective_until IS NULL OR effective_until>NOW())`,[planId]);
    if(!planResult.rowCount)throw new Error('Target plan not found or is not currently sellable');
    const target=planResult.rows[0],sub=await currentSubscription(item.customer_id);if(!sub)throw new Error('Customer has no subscription to change');
    if(subscriptionState.recurringProvider(sub)){
        const outcome=await planChange.requestChange({customerId:item.customer_id,targetPlanCode:target.code,timing:'auto',actorUserId:null});
        if(!outcome?.handled)throw new Error('Provider-managed plan change could not be applied through the billing lifecycle');
        await auditItem('admin.bulk.plan_change',item.customer_id,{planId,targetCode:target.code,provider:sub.source,mode:outcome.mode});
        return{planId,provider:sub.source,mode:outcome.mode};
    }
    subscriptionState.assertAudience(target,'customer');
    await query(`UPDATE subscriptions SET plan_id=$2,updated_at=NOW() WHERE id=$1`,[sub.subscription_id||sub.id,planId]);
    await provisioning.reconcileCustomer(item.customer_id);await auditItem('admin.bulk.plan_change',item.customer_id,{planId,mode:'local'});return{planId,mode:'local'};
});

// Administrative time gifts are provider-independent service extensions. They
// never rewrite Stripe/PayPal's current_period_end, so later provider sync
// cannot silently erase the adjustment. Each chunk is unique to this job item,
// making retries safe even after an uncertain worker outcome.
registerHandler('extend_entitlement',async item=>{
    const units=Number(item.params?.units)||1,sub=await currentSubscription(item.customer_id);if(!sub)throw new Error('Customer has no subscription to extend');
    const planResult=await query(`SELECT COALESCE($2::int,duration_days,30)::int AS duration_days FROM plans WHERE id=$1`,[sub.plan_id,Number(sub.duration_days_snapshot)||null]),durationDays=Math.max(1,Number(planResult.rows[0]?.duration_days||30)),requestedDays=durationDays*units,currentDays=Number(sub.service_extension_days||0);
    if(!Number.isInteger(requestedDays)||requestedDays<1||currentDays+requestedDays>3650)throw new Error('Requested service extension exceeds the 3,650-day safety limit');
    let remaining=requestedDays,chunk=0,added=0;
    while(remaining>0){const days=Math.min(365,remaining),reference=`bulk:${item.id}:${chunk}`;const didAdd=await transaction(async client=>{const inserted=await client.query(`INSERT INTO subscription_service_extension_events(subscription_id,customer_id,source,days,reference_id,metadata) VALUES($1,$2,'admin_bulk',$3,$4,$5::jsonb) ON CONFLICT(source,reference_id) DO NOTHING RETURNING id`,[sub.subscription_id||sub.id,item.customer_id,days,reference,JSON.stringify({jobItemId:item.id,units,chunk})]);if(!inserted.rowCount)return false;await client.query(`UPDATE subscriptions SET service_extension_days=service_extension_days+$2,updated_at=NOW() WHERE id=$1`,[sub.subscription_id||sub.id,days]);return true});if(didAdd)added+=days;remaining-=days;chunk++;}
    await provisioning.reconcileCustomer(item.customer_id);await auditItem('admin.bulk.extend_entitlement',item.customer_id,{units,requestedDays,addedDays:added});return{requestedDays,addedDays:added};
});

registerHandler('set_expiry',async item=>{
    const expiryDate=String(item.params?.expiryDate||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate))throw new Error('Invalid expiry date');const sub=await currentSubscription(item.customer_id);if(!sub)throw new Error('Customer has no subscription');
    if(subscriptionState.recurringProvider(sub))throw new Error('Expiry on a Stripe/PayPal recurring agreement is provider-controlled. Use the billing cancellation/plan-change workflow instead.');
    await query(`UPDATE subscriptions SET current_period_end=$2::date,service_extension_days=0,updated_at=NOW() WHERE id=$1`,[sub.subscription_id||sub.id,expiryDate]);await provisioning.reconcileCustomer(item.customer_id);await auditItem('admin.bulk.set_expiry',item.customer_id,{expiryDate,clearedServiceExtensions:true});return{expiryDate};
});
registerHandler('reset_overrides',async item=>{await provisioning.resetAllPolicyOverrides(item.customer_id,null);await provisioning.resetAllLibraryOverrides(item.customer_id);await provisioning.reconcileCustomer(item.customer_id);await auditItem('admin.bulk.reset_overrides',item.customer_id,{});return{}});

registerHandler('enable',async item=>{const outcome=await provisioning.releaseAccess(item.customer_id);await auditItem('admin.bulk.enable',item.customer_id,{active:Boolean(outcome?.active)});return{active:Boolean(outcome?.active)}});
registerHandler('disable',async item=>{const outcome=await provisioning.holdAccess(item.customer_id,'disabled');await auditItem('admin.bulk.disable',item.customer_id,{active:Boolean(outcome?.active)});return{active:Boolean(outcome?.active)}});
registerHandler('suspend',async item=>{const outcome=await provisioning.holdAccess(item.customer_id,'suspended');await auditItem('admin.bulk.suspend',item.customer_id,{active:Boolean(outcome?.active)});return{active:Boolean(outcome?.active)}});
registerHandler('reconcile',async item=>{const outcome=await provisioning.reconcileCustomer(item.customer_id);await auditItem('admin.bulk.reconcile',item.customer_id,{active:Boolean(outcome?.active)});return{active:Boolean(outcome?.active)}});
registerHandler('retry_failed',async item=>{const failed=await query(`SELECT jellyfin_account_id FROM jellyfin_policy_reconciliation WHERE customer_id=$1 AND status='failed'`,[item.customer_id]);let succeeded=0;const errors=[];for(const row of failed.rows){try{await provisioning.reconcileAccount(row.jellyfin_account_id);succeeded++}catch(error){errors.push(error.message)}}await auditItem('admin.bulk.retry_failed',item.customer_id,{attempted:failed.rows.length,succeeded,stillFailing:errors.length});if(errors.length)throw new Error(`${errors.length}/${failed.rows.length} account(s) still failing after retry: ${errors[0]}`);return{succeeded}});
registerHandler('revoke_sessions',async item=>{const sessions=await query(`SELECT server_id,jellyfin_session_id FROM active_playback_sessions WHERE customer_id=$1`,[item.customer_id]),registry=require('../jellyfin/registry');let revoked=0;for(const session of sessions.rows){try{await registry.request(session.server_id,`/Sessions/${encodeURIComponent(session.jellyfin_session_id)}/Logout`,{method:'POST'});revoked++}catch(_){}}await query('DELETE FROM active_playback_sessions WHERE customer_id=$1',[item.customer_id]);await auditItem('admin.bulk.revoke_sessions',item.customer_id,{revoked});return{revoked}});

registerHandler('reseller_assign',async item=>{
    const resellerId=String(item.params?.resellerId||''),resellerResult=await query('SELECT id FROM resellers WHERE id=$1',[resellerId]);if(!resellerResult.rowCount)throw new Error('Target reseller not found');
    const customer=await query('SELECT reseller_id FROM customers WHERE id=$1',[item.customer_id]);if(!customer.rowCount)throw new Error('Customer not found');if(String(customer.rows[0].reseller_id||'')===resellerId)return{resellerId,unchanged:true};
    const entitlement=await subscriptionState.effectiveSubscription(item.customer_id,{includeBlocked:true});if(entitlement?.source==='reseller_sale'){
        const parent=await monthly.currentSubscription(resellerId);if(!parent||!monthly.statusIsEntitled(parent))throw new Error('Target reseller has no active parent subscription for this commercial entitlement');const used=await monthly.seatUsage(resellerId),limit=Number(parent.seat_limit||parent.seat_limit_snapshot||0);if(used>=limit)throw new Error(`Target reseller has no free seats (${used}/${limit}).`);
    }
    await query('UPDATE customers SET reseller_id=$2 WHERE id=$1',[item.customer_id,resellerId]);await auditItem('admin.bulk.reseller_assign',item.customer_id,{resellerId});return{resellerId};
});
registerHandler('reseller_detach',async item=>{const entitlement=await subscriptionState.effectiveSubscription(item.customer_id,{includeBlocked:true});if(entitlement?.source==='reseller_sale')throw new Error('End the reseller-provided customer service before detaching the reseller; detaching alone would orphan a commercial entitlement.');await query('UPDATE customers SET reseller_id=NULL WHERE id=$1',[item.customer_id]);await auditItem('admin.bulk.reseller_detach',item.customer_id,{});return{}});

registerHandler('payments_sync',async item=>{const subs=await query(`SELECT source,provider_subscription_id FROM subscriptions WHERE customer_id=$1 AND source IN ('stripe','paypal') AND provider_subscription_id IS NOT NULL`,[item.customer_id]);let synced=0;const errors=[];for(const row of subs.rows){try{if(row.source==='stripe'&&stripe.enabled()){await stripe.syncSubscription(row.provider_subscription_id);synced++}else if(row.source==='paypal'&&paypal.enabled()){const remote=await paypal.getSubscription(row.provider_subscription_id);await lifecycle.updateProviderSubscription({provider:'paypal',providerSubscriptionId:row.provider_subscription_id,providerStatus:remote.status,periodEnd:remote.billing_info?.next_billing_time||null});synced++}}catch(error){console.error(`Payment sync failed for ${item.customer_id}:`,error.message);errors.push(`${row.source}: ${error.message}`)}}await auditItem('admin.bulk.payments_sync',item.customer_id,{synced,failed:errors.length});if(errors.length)throw new Error(`${errors.length} payment sync(s) failed: ${errors[0]}`);return{synced}});
module.exports={registerHandler};
