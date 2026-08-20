'use strict';

const { query } = require('../db');
const base = require('./provisioning');
const control = require('./reconciliation-control');
const accessHolds = require('../entitlements/access-holds');
const subscriptionExpiry = require('../entitlements/subscription-expiry');

function serviceType(entitlement){return String(entitlement?.service_type_snapshot||entitlement?.service_type||'jellyfin');}
function stateDetail(entitlement, outcome) {
    const account = outcome?.account || null;
    return {
        subscriptionId: entitlement?.subscription_id || null,
        planId: entitlement?.plan_id || null,
        accountId: account?.id || null,
        serverId: account?.server_id || outcome?.stremio?.serverId || null,
        serviceType: serviceType(entitlement),
        result: {
            active: Boolean(outcome?.active),
            planCode: entitlement?.code || null,
            jellyfinAccountId: account?.id || null,
            serverId: account?.server_id || outcome?.stremio?.serverId || null,
            stremioStatus: outcome?.stremio?.status || null,
            reconciledAt: new Date().toISOString()
        }
    };
}

async function disableNormalAccounts(customerId){
    const rows=await query(`SELECT * FROM jellyfin_accounts WHERE customer_id=$1 AND account_purpose='jellyfin' AND disabled=FALSE`,[customerId]);
    for(const account of rows.rows)await base.disableJellyfinAccount(account);
}

async function ensureNormalAccountIfHiddenWouldWin(customerId,entitlement){
    // A fresh Jellyfin/bundle customer has no accounts at all; let the canonical
    // provisioning-core path create the account so provisioning_runs, retries
    // and failure classification remain exactly as before. This guard is only
    // needed for the recovery edge where a hidden Stremio identity survived
    // but the customer-facing Jellyfin identity was removed externally.
    const accounts=await query(`SELECT id,account_purpose,server_id FROM jellyfin_accounts WHERE customer_id=$1`,[customerId]);
    if(!accounts.rows.some(row=>row.account_purpose==='stremio_internal'))return;
    if(accounts.rows.some(row=>row.account_purpose==='jellyfin'))return;
    const effective=await base.effectivePolicyForCustomer(customerId,entitlement),server=await base.selectServerForPlan(entitlement);
    if(!server)throw new Error(`No eligible Jellyfin server is currently available for plan ${entitlement.contract_plan_code||entitlement.code}`);
    await base.createJellyfinAccount(customerId,server,effective,{makePrimary:true});
}

async function reconcileCustomer(customerId) {
    const entitlement = await base.currentEntitlement(customerId);
    await control.markCustomerRunning(customerId, entitlement);
    try {
        const type=serviceType(entitlement),stremio=require('../stremio/entitlements');
        let outcome;
        if(entitlement&&type==='stremio'){
            await disableNormalAccounts(customerId);
            const s=await stremio.reconcileForCustomer(customerId,entitlement);
            outcome={active:s.status==='active',account:null,stremio:s};
        }else{
            if(entitlement&&['jellyfin','bundle'].includes(type))await ensureNormalAccountIfHiddenWouldWin(customerId,entitlement);
            outcome=await base.reconcileCustomer(customerId);
            if(entitlement&&type==='bundle')outcome.stremio=await stremio.reconcileForCustomer(customerId,entitlement);
            else await stremio.suspend(customerId,'Current subscription does not include Stremio.');
        }
        await control.markCustomerHealthy(customerId, stateDetail(entitlement, outcome));
        return outcome;
    } catch (error) {
        const classified = control.classifyError(error);
        await control.markCustomerProblem(customerId, classified.status, error, stateDetail(entitlement, null));
        throw error;
    }
}

async function reconcileAccount(accountId) {
    const result = await query('SELECT customer_id FROM jellyfin_accounts WHERE id=$1', [accountId]);
    if (!result.rowCount) throw new Error('Jellyfin account not found');
    return reconcileCustomer(result.rows[0].customer_id);
}

function adminHoldType(reason) {
    if (reason === 'disabled') return 'admin_disabled';
    if (reason === 'suspended') return 'admin_suspended';
    return 'admin_hold';
}
async function holdAccess(customerId, reason='suspended', actorUserId=null) {
    const type=adminHoldType(String(reason||'suspended'));
    await accessHolds.addHold({customerId,type,sourceKey:'admin',reason:String(reason||type).slice(0,500),actorUserId});
    return reconcileCustomer(customerId);
}
async function releaseAccess(customerId, actorUserId=null) {
    await accessHolds.releaseAllAdminHolds(customerId,actorUserId);
    return reconcileCustomer(customerId);
}

async function setJellyfinPassword(customerId, accountId, newPassword) {
    const account=await query(`SELECT account_purpose FROM jellyfin_accounts WHERE id=$1 AND customer_id=$2`,[accountId,customerId]);
    if(account.rows[0]?.account_purpose==='stremio_internal')throw new Error('Internal Stremio Jellyfin credentials cannot be changed through customer password controls.');
    return base.setJellyfinPassword(customerId, accountId, newPassword);
}

async function maybeAutoDowngrade(customerId){
    const lifecycle=require('../payments/lifecycle');
    try{return await lifecycle.autoDowngradeEligibleCustomer(customerId)}
    catch(error){console.error(`Automatic free-tier downgrade failed for ${customerId}:`,error.message);return null}
}
async function expireSubscriptionsAndReconcile() {
    return subscriptionExpiry.expireAndReconcile({
        reconcileCustomer,
        autoDowngrade: maybeAutoDowngrade,
        onReconcileError: (customerId,error) => console.error(`Entitlement reconcile failed for ${customerId}:`, error.message)
    });
}

module.exports = {
    ...base,
    reconcileCustomer,
    reconcileAccount,
    holdAccess,
    releaseAccess,
    setJellyfinPassword,
    expireSubscriptionsAndReconcile,
    control
};
