'use strict';

const {query,transaction}=require('../db');
const providerOps=require('./provider-operations');
const billingControl=require('./billing-control');
const permanentAccess=require('../entitlements/permanent-access');
const subscriptionState=require('../entitlements/subscription-state');

const OPERATION_TYPE='subscription_terminate';
const JELLYFIN_SERVICES=new Set(['jellyfin','bundle']);

function serviceType(row){return String(row?.effective_service_type||row?.service_type_snapshot||row?.service_type||'jellyfin').trim().toLowerCase();}
function assertJellyfinPrimary(row){
    if(!row)throw new Error('Subscription not found.');
    if(row.is_addon===true)throw new Error('Add-on subscriptions cannot be ended through the current Jellyfin plan action.');
    if(!JELLYFIN_SERVICES.has(serviceType(row)))throw new Error('This subscription does not provide current Jellyfin access.');
    return row;
}
function reasonText(value){return String(value||'Current Jellyfin plan ended by administrator').trim().slice(0,500)||'Current Jellyfin plan ended by administrator';}
function manual(message){const error=new Error(message);error.providerOperationManual=true;return error;}

async function subscriptionRow(subscriptionId,{client=null}={}){
    const db=client||{query};
    const result=await db.query(`
        SELECT s.*,p.is_addon,p.service_type,
               COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') AS effective_service_type
        FROM subscriptions s
        JOIN plans p ON p.id=s.plan_id
        WHERE s.id=$1
        LIMIT 1
    `,[subscriptionId]);
    return result.rows[0]||null;
}

async function currentJellyfinSubscription(customerId){
    const row=await subscriptionState.effectiveSubscription(customerId,{includeBlocked:true});
    if(!row||row.is_addon===true||!JELLYFIN_SERVICES.has(serviceType(row)))return null;
    return row;
}

async function terminateLocal(subscriptionId,customerId,{actorUserId=null,reason='',providerBillingChanged=false,reference=null}={}){
    const note=reasonText(reason),auditReference=reference?String(reference).slice(0,200):null;
    return transaction(async client=>{
        const row=await client.query(`
            SELECT s.*,p.is_addon,p.service_type,
                   COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') AS effective_service_type
            FROM subscriptions s
            JOIN plans p ON p.id=s.plan_id
            WHERE s.id=$1 AND s.customer_id=$2
            FOR UPDATE OF s
        `,[subscriptionId,customerId]);
        const subscription=assertJellyfinPrimary(row.rows[0]||null);
        const permanent=await permanentAccess.revokeInTransaction(client,customerId,{actorUserId,reason:`Jellyfin plan ended: ${note}`.slice(0,500),expectedSubscriptionId:subscription.id});
        if(permanent.subscriptionMismatch)throw new Error('Permanent access is pinned to a different subscription. Reconcile the customer before ending this plan.');
        const ended=await client.query(`
            UPDATE subscriptions
            SET status='cancelled',current_period_end=LEAST(COALESCE(current_period_end,NOW()),NOW()),service_extension_days=0,cancel_at_period_end=TRUE,updated_at=NOW()
            WHERE id=$1 AND customer_id=$2
            RETURNING id,status,current_period_end,cancel_at_period_end,service_extension_days
        `,[subscription.id,customerId]);
        if(!ended.rowCount)throw new Error('Subscription changed before it could be ended.');
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'billing.subscription.terminate_local','subscription',$2,$3::jsonb)`,[actorUserId,subscription.id,JSON.stringify({customerId,reason:note,reference:auditReference,serviceType:serviceType(subscription),provider:subscription.source||null,providerBillingChanged:Boolean(providerBillingChanged),permanentAccessRevoked:Boolean(permanent.changed)})]);
        return{...ended.rows[0],customerId,serviceType:serviceType(subscription),provider:subscription.source||null,permanentAccessRevoked:Boolean(permanent.changed),providerBillingChanged:Boolean(providerBillingChanged),reference:auditReference};
    });
}

async function continueRecurringOperation(op,row,{adapter=null,actorUserId=null,reason='',recovered=false}={}){
    assertJellyfinPrimary(row);
    if(String(row.customer_id)!==String(op.owner_id))throw manual('Termination subscription no longer belongs to this provider operation owner.');
    if(!billingControl.isRecurring(row))throw manual('Termination recovery no longer points to a recurring Stripe/PayPal subscription.');
    if(op.state==='reconciled')return{ok:true,reused:true,providerOperationId:op.id,subscriptionId:row.id};
    const note=reasonText(reason||op.request_snapshot?.reason);
    const remote=await billingControl.terminateRecurringForDeletion(row,{adapter,idempotencyKey:op.idempotency_key});
    await providerOps.observed(op.id,{result:{terminationStatus:remote.status,remoteStatus:remote.remoteStatus||null,recovered:Boolean(recovered)}});
    if(!['provider_applied','local_applied'].includes(op.state))await providerOps.providerApplied(op.id,{providerReference:row.provider_subscription_id,result:{terminationStatus:remote.status,remoteStatus:remote.remoteStatus||null,recovered:Boolean(recovered)}});
    let local=null;
    if(op.state!=='local_applied'){
        local=await terminateLocal(row.id,row.customer_id,{actorUserId,reason:note,providerBillingChanged:true,reference:op.idempotency_key});
        await providerOps.localApplied(op.id,{localReference:row.id,result:{subscriptionStatus:local.status,currentPeriodEnd:local.current_period_end,permanentAccessRevoked:local.permanentAccessRevoked,recovered:Boolean(recovered)}});
    }
    await providerOps.reconciled(op.id,{result:{subscriptionId:row.id,customerId:row.customer_id,terminated:true,recovered:Boolean(recovered)}});
    return{ok:true,providerOperationId:op.id,subscriptionId:row.id,provider:row.source,remote,local,recovered:Boolean(recovered)};
}

async function terminateRecurringNow(row,{actorUserId=null,reason='',idempotencyKey=null,adapter=null}={}){
    const subscriptionId=row?.subscription_id||row?.id;
    const current=assertJellyfinPrimary(await subscriptionRow(subscriptionId));
    if(!billingControl.isRecurring(current))throw new Error('This is not a recurring Stripe/PayPal subscription.');
    const note=reasonText(reason);
    const op=await providerOps.begin({
        provider:current.source,
        scope:'customer',
        ownerId:current.customer_id,
        operationType:OPERATION_TYPE,
        localReference:current.id,
        idempotencyKey:idempotencyKey||`subscription-terminate:${current.id}`,
        request:{subscriptionId:current.id,providerSubscriptionId:current.provider_subscription_id,serviceType:serviceType(current),reason:note}
    });
    try{return await continueRecurringOperation(op,current,{adapter,actorUserId,reason:note,recovered:false});}
    catch(error){await providerOps.recordError(op.id,error).catch(()=>{});throw error;}
}

async function recoverProviderOperation(op,{adapter=null}={}){
    if(op.operation_type!==OPERATION_TYPE)throw manual(`Unsupported subscription termination recovery type ${op.operation_type}.`);
    const request=op.request_snapshot||{},subscriptionId=request.subscriptionId||op.local_reference;
    if(!subscriptionId)throw manual('Termination recovery snapshot is missing its subscription reference.');
    const row=await subscriptionRow(subscriptionId);
    if(!row)throw manual('Termination subscription no longer exists locally.');
    const result=await continueRecurringOperation(op,row,{adapter,reason:request.reason,recovered:true});
    try{await require('../jellyfin/resilient-provisioning').reconcileCustomer(row.customer_id);}catch(error){console.warn('Recovered subscription termination access reconciliation deferred:',error.message);}
    return{...result,id:op.id,type:op.operation_type};
}

module.exports={OPERATION_TYPE,JELLYFIN_SERVICES,serviceType,assertJellyfinPrimary,subscriptionRow,currentJellyfinSubscription,terminateLocal,terminateRecurringNow,recoverProviderOperation};
