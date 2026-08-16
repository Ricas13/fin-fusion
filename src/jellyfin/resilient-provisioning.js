'use strict';

const { query, transaction } = require('../db');
const base = require('./provisioning');
const control = require('./reconciliation-control');
const accessHolds = require('../entitlements/access-holds');

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
    const expired = await transaction(async client => {
        const rows=await client.query(`
            WITH expired AS (
                UPDATE subscriptions
                SET status='expired',service_extension_days=0,updated_at=NOW()
                WHERE superseded_by IS NULL
                  AND (
                    (status IN('active','trialing','past_due','paused','cancelled')
                     AND current_period_end+(COALESCE(service_extension_days,0)||' days')::interval<=NOW())
                    OR
                    (status='expired' AND COALESCE(service_extension_days,0)>0
                     AND current_period_end+(service_extension_days||' days')::interval<=NOW())
                  )
                RETURNING customer_id,plan_id,source
            )
            SELECT DISTINCT e.customer_id,BOOL_OR(p.price_minor>0) AS had_paid_expiry
            FROM expired e JOIN plans p ON p.id=e.plan_id
            GROUP BY e.customer_id
        `);
        return rows.rows;
    });
    for (const row of expired) {
        const customerId=row.customer_id;
        let downgraded=null;
        if(row.had_paid_expiry)downgraded=await maybeAutoDowngrade(customerId);
        if(downgraded)continue;
        try { await reconcileCustomer(customerId); }
        catch (error) { console.error(`Entitlement reconcile failed for ${customerId}:`, error.message); }
    }
    return expired.length;
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
