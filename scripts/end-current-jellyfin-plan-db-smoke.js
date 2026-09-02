'use strict';

const assert=require('assert');
const crypto=require('crypto');
const {query,getPool}=require('../src/db');
const termination=require('../src/payments/subscription-termination');
const providerOps=require('../src/payments/provider-operations');

(async()=>{
    const suffix=crypto.randomBytes(5).toString('hex');
    const users=[],customers=[],subscriptions=[],operationKeys=[];
    const plan=(await query(`SELECT id FROM plans WHERE COALESCE(is_addon,FALSE)=FALSE AND service_type IN ('jellyfin','bundle') ORDER BY is_free_tier DESC,created_at,id LIMIT 1`)).rows[0];
    assert(plan,'clean install must contain at least one primary Jellyfin/bundle plan');

    async function fixture(label,{source='free_claim',providerSubscriptionId=null,billingMode=null,permanent=false}={}){
        const user=await query(`INSERT INTO app_users(username,password_hash,role,active,email_verified_at) VALUES($1,'test-hash','customer',TRUE,NOW()) RETURNING id`,[`endplan_${label}_${suffix}`]);
        users.push(user.rows[0].id);
        const customer=await query(`INSERT INTO customers(user_id,display_name,automation_protected) VALUES($1,$2,$3) RETURNING id`,[user.rows[0].id,`End plan ${label} ${suffix}`,Boolean(permanent)]);
        customers.push(customer.rows[0].id);
        const sub=await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,billing_mode,starts_at,current_period_end,service_extension_days,cancel_at_period_end) VALUES($1,$2,'active',$3,$4,COALESCE($5,CASE WHEN $3 IN ('stripe','paypal','plisio') THEN 'payment' ELSE 'manual' END),NOW()-INTERVAL '1 day',NOW()+INTERVAL '30 days',5,FALSE) RETURNING id`,[customer.rows[0].id,plan.id,source,providerSubscriptionId,billingMode]);
        subscriptions.push(sub.rows[0].id);
        if(permanent)await query(`INSERT INTO customer_entitlement_overrides(customer_id,subscription_id,permanent_access,reason,previous_automation_protected) VALUES($1,$2,TRUE,'DB smoke permanent access',FALSE)`,[customer.rows[0].id,sub.rows[0].id]);
        return{customerId:customer.rows[0].id,subscriptionId:sub.rows[0].id};
    }

    try{
        const local=await fixture('local');
        const current=await termination.currentJellyfinSubscription(local.customerId);
        assert.strictEqual(String(current.subscription_id),String(local.subscriptionId),'current plan resolver must return the effective Jellyfin subscription');
        const localResult=await termination.terminateLocal(local.subscriptionId,local.customerId,{reason:'DB smoke local end',reference:`db-local-${suffix}`});
        assert.strictEqual(localResult.status,'cancelled');
        assert.strictEqual(localResult.cancel_at_period_end,true);
        assert.strictEqual(Number(localResult.service_extension_days),0);
        assert(new Date(localResult.current_period_end).getTime()<=Date.now()+2000,'local end must close entitlement immediately');
        assert.strictEqual(await termination.currentJellyfinSubscription(local.customerId),null,'ended local subscription must stop being effective');

        const pinned=await fixture('permanent',{permanent:true});
        const pinnedResult=await termination.terminateLocal(pinned.subscriptionId,pinned.customerId,{reason:'DB smoke pinned end',reference:`db-pinned-${suffix}`});
        assert.strictEqual(pinnedResult.permanentAccessRevoked,true,'ending a pinned plan must revoke permanent access atomically');
        const override=(await query(`SELECT permanent_access,revoked_at FROM customer_entitlement_overrides WHERE customer_id=$1`,[pinned.customerId])).rows[0];
        assert.strictEqual(override.permanent_access,false);
        assert(override.revoked_at,'permanent override must record revocation time');
        const protectedState=(await query(`SELECT automation_protected FROM customers WHERE id=$1`,[pinned.customerId])).rows[0];
        assert.strictEqual(protectedState.automation_protected,false,'previous automation-protection state must be restored');
        assert.strictEqual(await termination.currentJellyfinSubscription(pinned.customerId),null,'revoked permanent pin must not keep the ended plan effective');

        const recurring=await fixture('recurring',{source:'stripe',providerSubscriptionId:`sub_endplan_${suffix}`,billingMode:'subscription'});
        const recurringKey=`db-end-recurring-${suffix}`;operationKeys.push(recurringKey);
        let terminateCalls=0,seenKey=null;
        const fakeAdapter={terminate:async(_row,{idempotencyKey}={})=>{terminateCalls++;seenKey=idempotencyKey;return{status:'cancelled',remoteStatus:'canceled'};}};
        const recurringResult=await termination.terminateRecurringNow({id:recurring.subscriptionId},{reason:'DB smoke provider end',idempotencyKey:recurringKey,adapter:fakeAdapter});
        assert.strictEqual(terminateCalls,1,'provider adapter must be invoked exactly once in the normal path');
        assert.strictEqual(seenKey,recurringKey,'stable provider idempotency key must reach the adapter');
        assert(recurringResult.providerOperationId,'provider-managed termination must create a durable operation');
        const recurringOp=await providerOps.get(recurringResult.providerOperationId);
        assert.strictEqual(recurringOp.state,'reconciled','provider operation must reach reconciled after local convergence');
        assert.strictEqual((await query(`SELECT status FROM subscriptions WHERE id=$1`,[recurring.subscriptionId])).rows[0].status,'cancelled');

        const recovery=await fixture('recovery',{source:'stripe',providerSubscriptionId:`sub_endplan_recovery_${suffix}`,billingMode:'subscription'});
        const recoveryKey=`db-end-recovery-${suffix}`;operationKeys.push(recoveryKey);
        const op=await providerOps.begin({provider:'stripe',scope:'customer',ownerId:recovery.customerId,operationType:termination.OPERATION_TYPE,localReference:recovery.subscriptionId,idempotencyKey:recoveryKey,request:{subscriptionId:recovery.subscriptionId,providerSubscriptionId:`sub_endplan_recovery_${suffix}`,reason:'DB smoke recover provider-applied termination'}});
        await providerOps.providerApplied(op.id,{providerReference:`sub_endplan_recovery_${suffix}`,result:{terminationStatus:'cancelled',remoteStatus:'canceled'}});
        let recoveryCalls=0;
        const recovered=await termination.recoverProviderOperation(await providerOps.get(op.id),{adapter:{terminate:async()=>{recoveryCalls++;return{status:'cancelled',remoteStatus:'canceled'};}}});
        assert.strictEqual(recoveryCalls,1,'recovery must re-verify the terminal provider state through the canonical adapter');
        assert.strictEqual(recovered.recovered,true);
        assert.strictEqual((await providerOps.get(op.id)).state,'reconciled','provider-applied/local-missing divergence must converge automatically');
        assert.strictEqual((await query(`SELECT status FROM subscriptions WHERE id=$1`,[recovery.subscriptionId])).rows[0].status,'cancelled');

        console.log('end current jellyfin plan db smoke: ok');
    }finally{
        if(customers.length)await query(`DELETE FROM audit_log WHERE entity_id=ANY($1::text[]) OR metadata->>'customerId'=ANY($1::text[])`,[customers.map(String)]).catch(()=>{});
        if(subscriptions.length)await query(`DELETE FROM audit_log WHERE entity_id=ANY($1::text[])`,[subscriptions.map(String)]).catch(()=>{});
        if(operationKeys.length)await query(`DELETE FROM provider_operations WHERE idempotency_key=ANY($1::text[])`,[operationKeys]).catch(()=>{});
        for(const customerId of customers.reverse())await query('DELETE FROM customers WHERE id=$1',[customerId]).catch(()=>{});
        for(const userId of users.reverse())await query('DELETE FROM app_users WHERE id=$1',[userId]).catch(()=>{});
    }
})().finally(()=>getPool().end()).catch(error=>{console.error(error);process.exit(1);});