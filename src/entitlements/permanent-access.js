'use strict';

const {query,transaction}=require('../db');
const provisioning=require('../jellyfin/resilient-provisioning');
const subscriptionState=require('./subscription-state');
const accessHolds=require('./access-holds');

function reasonText(value){return String(value||'Permanent access granted by administrator').trim().slice(0,500)||'Permanent access granted by administrator';}
function revokeReasonText(value){return String(value||'Permanent access removed by administrator').trim().slice(0,500)||'Permanent access removed by administrator';}

async function status(customerId,{client=null}={}){
    const db=client||{query};
    const result=await db.query(`
        SELECT o.*,p.name AS plan_name,p.code AS plan_code,s.current_period_end,s.status AS subscription_status,s.superseded_by,
          EXISTS(
            SELECT 1 FROM effective_customer_entitlements e
            WHERE e.customer_id=o.customer_id AND e.subscription_id=o.subscription_id
          ) AS is_effective_subscription
        FROM customer_entitlement_overrides o
        JOIN subscriptions s ON s.id=o.subscription_id
        JOIN plans p ON p.id=s.plan_id
        WHERE o.customer_id=$1
    `,[customerId]);
    const row=result.rows[0]||null;
    const current=Boolean(row&&!row.superseded_by&&row.is_effective_subscription);
    return row?{...row,active:Boolean(row.permanent_access&&!row.revoked_at&&current),stale:Boolean(row.permanent_access&&!row.revoked_at&&!current)}:null;
}

async function enable(customerId,{actorUserId=null,reason=''}={}){
    const note=reasonText(reason);
    const saved=await transaction(async client=>{
        const customer=await client.query(`SELECT id,automation_protected,automation_protected_reason,automation_protected_at,automation_protected_by FROM customers WHERE id=$1 FOR UPDATE`,[customerId]);
        if(!customer.rowCount)throw new Error('Customer not found.');
        // Permanent access must pin the same primary Jellyfin/bundle contract
        // used by runtime reconciliation. In parallel Free + Premium access,
        // the free lane is independent and must never win through view/row order.
        const entitlement=await subscriptionState.effectiveSubscription(customerId,{client,includeBlocked:true});
        if(!entitlement)throw new Error('Give the customer an active plan before making access permanent.');
        const subId=entitlement.subscription_id;
        const existing=await client.query('SELECT * FROM customer_entitlement_overrides WHERE customer_id=$1 FOR UPDATE',[customerId]);
        if(existing.rowCount&&existing.rows[0].permanent_access&&!existing.rows[0].revoked_at){
            const prior=existing.rows[0],repinned=String(prior.subscription_id)!==String(subId);
            await client.query(`UPDATE customer_entitlement_overrides SET subscription_id=$2,reason=$3,updated_by=$4,updated_at=NOW() WHERE customer_id=$1`,[customerId,subId,note,actorUserId]);
            if(repinned)await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.permanent_access.repin','customer',$2,$3::jsonb)`,[actorUserId,customerId,JSON.stringify({fromSubscriptionId:prior.subscription_id,toSubscriptionId:subId,reason:note,providerBillingChanged:false})]);
            return{subscriptionId:subId,reused:!repinned,repinned};
        }
        const previousProtected=Boolean(customer.rows[0].automation_protected),previousReason=customer.rows[0].automation_protected_reason||null,previousAt=customer.rows[0].automation_protected_at||null,previousBy=customer.rows[0].automation_protected_by||null;
        await client.query(`
            INSERT INTO customer_entitlement_overrides(customer_id,subscription_id,permanent_access,reason,created_by,updated_by,previous_automation_protected,previous_automation_reason,previous_automation_protected_at,previous_automation_protected_by,revoked_at,revoked_by,updated_at)
            VALUES($1,$2,TRUE,$3,$4,$4,$5,$6,$7,$8,NULL,NULL,NOW())
            ON CONFLICT(customer_id) DO UPDATE SET subscription_id=EXCLUDED.subscription_id,permanent_access=TRUE,reason=EXCLUDED.reason,updated_by=EXCLUDED.updated_by,updated_at=NOW(),previous_automation_protected=EXCLUDED.previous_automation_protected,previous_automation_reason=EXCLUDED.previous_automation_reason,previous_automation_protected_at=EXCLUDED.previous_automation_protected_at,previous_automation_protected_by=EXCLUDED.previous_automation_protected_by,revoked_at=NULL,revoked_by=NULL
        `,[customerId,subId,note,actorUserId,previousProtected,previousReason,previousAt,previousBy]);
        await client.query(`UPDATE customers SET automation_protected=TRUE,automation_protected_reason=$2,automation_protected_at=NOW(),automation_protected_by=$3,updated_at=NOW() WHERE id=$1`,[customerId,`Permanent access: ${note}`.slice(0,500),actorUserId]);
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.permanent_access.enable','customer',$2,$3::jsonb)`,[actorUserId,customerId,JSON.stringify({subscriptionId:subId,reason:note,providerBillingChanged:false,previousAutomationProtected:previousProtected,previousAutomationProtectedAt:previousAt,previousAutomationProtectedBy:previousBy})]);
        return{subscriptionId:subId,reused:false,repinned:false};
    });
    await provisioning.reconcileCustomer(customerId).catch(error=>console.warn('Permanent access reconciliation deferred:',error.message));
    return{...saved,status:await status(customerId)};
}

async function revokeInTransaction(client,customerId,{actorUserId=null,reason='',expectedSubscriptionId=null}={}){
    const note=revokeReasonText(reason);
    const row=await client.query('SELECT * FROM customer_entitlement_overrides WHERE customer_id=$1 FOR UPDATE',[customerId]);
    if(!row.rowCount||!row.rows[0].permanent_access||row.rows[0].revoked_at)return{changed:false};
    const current=row.rows[0];
    if(expectedSubscriptionId&&String(current.subscription_id)!==String(expectedSubscriptionId))return{changed:false,subscriptionMismatch:true,subscriptionId:current.subscription_id};

    // A Free Server user that was previously removed for inactivity can still
    // carry the old inactivity hold while an admin-forced/permanent override is
    // keeping the newly re-added Jellyfin account present. If we revoke the
    // permanent override first, the reconciliation at the end of revoke() sees
    // that stale hold and removes the account immediately. Release only the
    // matching Free-plan inactivity hold in this same transaction, before the
    // override becomes non-permanent. PR #634 then uses revoked_at as the start
    // of the fresh inactivity observation window.
    const plan=await client.query(`
        SELECT p.id AS plan_id,p.is_free_tier,p.price_minor,
               COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') AS service_type
        FROM subscriptions s
        JOIN plans p ON p.id=s.plan_id
        WHERE s.id=$1 AND s.customer_id=$2
        LIMIT 1
    `,[current.subscription_id,customerId]);
    const contract=plan.rows[0]||null;
    const freeJellyfin=Boolean(contract?.is_free_tier&&Number(contract?.price_minor||0)===0&&['jellyfin','bundle'].includes(String(contract?.service_type||'jellyfin').toLowerCase()));
    if(freeJellyfin){
        await accessHolds.releaseHold({
            customerId,
            type:'inactivity_policy',
            sourceKey:`plan:${contract.plan_id}`,
            actorUserId,
            resolutionReason:'Free Server returned to automation; start a fresh inactivity observation window'
        },client);
    }

    await client.query(`UPDATE customer_entitlement_overrides SET permanent_access=FALSE,reason=$2,revoked_at=NOW(),revoked_by=$3,updated_by=$3,updated_at=NOW() WHERE customer_id=$1`,[customerId,note,actorUserId]);
    await client.query(`UPDATE customers SET automation_protected=$2,automation_protected_reason=$3,automation_protected_at=CASE WHEN $2 THEN $4::timestamptz ELSE NULL END,automation_protected_by=CASE WHEN $2 THEN $5::uuid ELSE NULL END,updated_at=NOW() WHERE id=$1`,[customerId,Boolean(current.previous_automation_protected),current.previous_automation_reason||null,current.previous_automation_protected_at||null,current.previous_automation_protected_by||null]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.permanent_access.revoke','customer',$2,$3::jsonb)`,[actorUserId,customerId,JSON.stringify({subscriptionId:current.subscription_id,reason:note,providerBillingChanged:false,restoredAutomationProtected:Boolean(current.previous_automation_protected),restoredAutomationProtectedAt:current.previous_automation_protected_at||null,restoredAutomationProtectedBy:current.previous_automation_protected_by||null,freeInactivityHoldReleasedBeforeAutomationResume:freeJellyfin})]);
    return{changed:true,subscriptionId:current.subscription_id};
}

async function revoke(customerId,{actorUserId=null,reason=''}={}){
    const result=await transaction(client=>revokeInTransaction(client,customerId,{actorUserId,reason}));
    await provisioning.reconcileCustomer(customerId).catch(error=>console.warn('Permanent access revoke reconciliation deferred:',error.message));
    return{...result,status:await status(customerId)};
}

module.exports={status,enable,revoke,revokeInTransaction};
