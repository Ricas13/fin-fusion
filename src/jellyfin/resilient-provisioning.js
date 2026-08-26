'use strict';

const { query } = require('../db');
const base = require('./provisioning');
const control = require('./reconciliation-control');
const accessHolds = require('../entitlements/access-holds');
const subscriptionState = require('../entitlements/subscription-state');
const subscriptionExpiry = require('../entitlements/subscription-expiry');

function serviceType(entitlement){return String(entitlement?.service_type_snapshot||entitlement?.service_type||'jellyfin');}
function laneState(result){return result?{active:Boolean(result.active),blocked:Boolean(result.blocked),subscriptionId:result.entitlement?.subscription_id||null,planId:result.entitlement?.plan_id||null,planCode:result.entitlement?.contract_plan_code||result.entitlement?.code||null,accountId:result.account?.id||null,serverId:result.account?.server_id||null}:null;}
function stateDetail(primaryEntitlement,outcome) {
    const account = outcome?.account || null;
    return {
        subscriptionId: primaryEntitlement?.subscription_id || outcome?.free?.entitlement?.subscription_id || outcome?.stremio?.subscriptionId || null,
        planId: primaryEntitlement?.plan_id || outcome?.free?.entitlement?.plan_id || null,
        accountId: account?.id || null,
        serverId: account?.server_id || outcome?.stremio?.serverId || null,
        serviceType: serviceType(primaryEntitlement),
        result: {
            active: Boolean(outcome?.active),
            planCode: primaryEntitlement?.contract_plan_code || primaryEntitlement?.code || null,
            jellyfinAccountId: account?.id || null,
            serverId: account?.server_id || outcome?.stremio?.serverId || null,
            primary:laneState(outcome?.primary),
            free:laneState(outcome?.free),
            stremioStatus: outcome?.stremio?.status || null,
            reconciledAt: new Date().toISOString()
        }
    };
}

async function normalAccounts(customerId){
    const rows=await query(`
        SELECT ja.*,js.enabled AS server_enabled,js.server_class,js.name AS server_name,js.public_url
        FROM jellyfin_accounts ja
        JOIN jellyfin_servers js ON js.id=ja.server_id
        WHERE ja.customer_id=$1 AND ja.account_purpose='jellyfin'
        ORDER BY ja.is_primary DESC,ja.disabled ASC,ja.created_at ASC
    `,[customerId]);
    return rows.rows;
}

async function disableAccounts(accounts){
    for(const account of accounts){
        if(!account.disabled&&account.server_enabled)await base.disableJellyfinAccount(account);
    }
}

async function adoptFreeOnlyAccount(customerId,accounts,entitlement){
    if(!entitlement?.is_free_tier)return accounts;
    if(accounts.some(account=>account.access_lane==='free'))return accounts;
    const candidate=accounts.find(account=>account.server_class===entitlement.server_class&&account.server_enabled)||accounts.find(account=>account.server_enabled);
    if(!candidate)return accounts;
    await query(`UPDATE jellyfin_accounts SET access_lane='free',updated_at=NOW() WHERE id=$1`,[candidate.id]);
    candidate.access_lane='free';
    return accounts;
}

async function createLaneAccount(customerId,entitlement,lane,effective,makePrimary){
    const server=await base.selectServerForPlan(entitlement);
    if(!server)throw new Error(`No eligible Jellyfin server is currently available for plan ${entitlement.contract_plan_code||entitlement.code}`);
    const account=await base.createJellyfinAccount(customerId,server,effective,{makePrimary});
    await query(`UPDATE jellyfin_accounts SET access_lane=$2,updated_at=NOW() WHERE id=$1`,[account.id,lane]);
    account.access_lane=lane;
    account.server_name=server.name;
    account.public_url=server.public_url;
    base.notifyNewJellyfinAccess(customerId,account).catch(()=>{});
    return account;
}

async function reconcileLane(customerId,entitlement,lane,accounts,{makePrimary=false}={}){
    const laneAccounts=accounts.filter(account=>account.access_lane===lane);
    if(!entitlement||entitlement.blocked){
        await disableAccounts(laneAccounts);
        return{active:false,blocked:Boolean(entitlement?.blocked),entitlement:entitlement||null,account:null};
    }
    const effective=await base.effectivePolicyForCustomer(customerId,entitlement);
    let account=laneAccounts.find(a=>a.is_primary&&a.server_class===entitlement.server_class&&a.server_enabled)
        ||laneAccounts.find(a=>!a.disabled&&a.server_class===entitlement.server_class&&a.server_enabled)
        ||laneAccounts.find(a=>a.server_class===entitlement.server_class&&a.server_enabled);
    if(!account){
        account=await createLaneAccount(customerId,entitlement,lane,effective,makePrimary);
        accounts.push(account);
    }else{
        await base.applyPolicy(account,effective,false);
        account.disabled=false;
        if(makePrimary&&!account.is_primary){await base.markPrimaryAccount(customerId,account.id);for(const existing of accounts)existing.is_primary=existing.id===account.id;account.is_primary=true;}
    }
    await disableAccounts(laneAccounts.filter(old=>old.id!==account.id));
    await query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('entitlement.reconcile_lane','customer',$1,$2::jsonb)`,[customerId,JSON.stringify({lane,subscriptionId:entitlement.subscription_id,planCode:entitlement.contract_plan_code||entitlement.code,serverId:account.server_id,jellyfinAccountId:account.id})]);
    return{active:true,blocked:false,entitlement,account,effective};
}

async function recordRun(customerId,subscriptionId,fn){
    const started=await query(`INSERT INTO provisioning_runs(customer_id,subscription_id,action,status) VALUES($1,$2,'reconcile_multi_access','started') RETURNING id`,[customerId,subscriptionId||null]);
    const id=started.rows[0].id;
    try{const value=await fn();await query(`UPDATE provisioning_runs SET status='succeeded',completed_at=NOW() WHERE id=$1`,[id]);return value;}
    catch(error){await query(`UPDATE provisioning_runs SET status='failed',detail=$2::jsonb,completed_at=NOW() WHERE id=$1`,[id,JSON.stringify({error:error.message})]);throw error;}
}

async function reconcileCustomer(customerId) {
    const [effectiveJellyfin,freeEntitlement,stremioEntitlement]=await Promise.all([
        base.currentEntitlement(customerId),
        subscriptionState.liveFreeJellyfinSubscription(customerId,{includeBlocked:true}),
        require('../stremio/entitlements').entitledSubscription(customerId)
    ]);
    const primaryEntitlement=effectiveJellyfin&&!effectiveJellyfin.is_free_tier?effectiveJellyfin:null;
    const controlEntitlement=primaryEntitlement||freeEntitlement||stremioEntitlement||null;
    await control.markCustomerRunning(customerId,controlEntitlement);
    try {
        const outcome=await recordRun(customerId,controlEntitlement?.subscription_id||null,async()=>{
            let accounts=await normalAccounts(customerId);
            if(!primaryEntitlement)accounts=await adoptFreeOnlyAccount(customerId,accounts,freeEntitlement);
            const primary=await reconcileLane(customerId,primaryEntitlement,'primary',accounts,{makePrimary:Boolean(primaryEntitlement)});
            const free=await reconcileLane(customerId,freeEntitlement,'free',accounts,{makePrimary:!primaryEntitlement&&Boolean(freeEntitlement&&!freeEntitlement.blocked)});
            if(!primaryEntitlement&&!free.active)await disableAccounts(accounts);

            const stremio=require('../stremio/entitlements');
            let stremioOutcome=null;
            if(stremioEntitlement)stremioOutcome=await stremio.reconcileForCustomer(customerId,stremioEntitlement);
            else await stremio.suspend(customerId,'No current Stremio subscription.');

            const account=primary.account||free.account||null;
            return{active:Boolean(primary.active||free.active||stremioOutcome?.status==='active'),account,primary,free,stremio:stremioOutcome};
        });
        await control.markCustomerHealthy(customerId,stateDetail(controlEntitlement,outcome));
        return outcome;
    } catch (error) {
        const classified=control.classifyError(error);
        await control.markCustomerProblem(customerId,classified.status,error,stateDetail(controlEntitlement,null));
        throw error;
    }
}

async function reconcileAccount(accountId) {
    const result=await query('SELECT customer_id FROM jellyfin_accounts WHERE id=$1',[accountId]);
    if(!result.rowCount)throw new Error('Jellyfin account not found');
    return reconcileCustomer(result.rows[0].customer_id);
}

function adminHoldType(reason) {
    if(reason==='disabled')return'admin_disabled';
    if(reason==='suspended')return'admin_suspended';
    return'admin_hold';
}
async function holdAccess(customerId,reason='suspended',actorUserId=null) {
    const type=adminHoldType(String(reason||'suspended'));
    await accessHolds.addHold({customerId,type,sourceKey:'admin',reason:String(reason||type).slice(0,500),actorUserId});
    return reconcileCustomer(customerId);
}
async function releaseAccess(customerId,actorUserId=null) {
    await accessHolds.releaseAllAdminHolds(customerId,actorUserId);
    return reconcileCustomer(customerId);
}

async function setJellyfinPassword(customerId,accountId,newPassword) {
    const account=await query(`SELECT account_purpose FROM jellyfin_accounts WHERE id=$1 AND customer_id=$2`,[accountId,customerId]);
    if(account.rows[0]?.account_purpose==='stremio_internal')throw new Error('Internal Stremio Jellyfin credentials cannot be changed through customer password controls.');
    return base.setJellyfinPassword(customerId,accountId,newPassword);
}

async function maybeAutoDowngrade(customerId){
    const lifecycle=require('../payments/lifecycle');
    try{return await lifecycle.autoDowngradeEligibleCustomer(customerId)}
    catch(error){console.error(`Automatic free-tier downgrade failed for ${customerId}:`,error.message);return null}
}
async function expireSubscriptionsAndReconcile() {
    return subscriptionExpiry.expireAndReconcile({
        reconcileCustomer,
        autoDowngrade:maybeAutoDowngrade,
        onReconcileError:(customerId,error)=>console.error(`Entitlement reconcile failed for ${customerId}:`,error.message)
    });
}

module.exports={...base,reconcileCustomer,reconcileAccount,holdAccess,releaseAccess,setJellyfinPassword,expireSubscriptionsAndReconcile,normalAccounts,reconcileLane,control};
