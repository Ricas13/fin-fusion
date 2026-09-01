'use strict';

const {transaction}=require('../db');
const capacity=require('../entitlements/plan-capacity');
const billingPeriods=require('./billing-periods');
const discounts=require('./discounts');
const checkoutIntents=require('./checkout-intents');
const lifecyclePrimitives=require('./lifecycle-primitives');
const inactivityHolds=require('../entitlements/inactivity-hold-reconciliation');

function money(value){const n=Number(value);return Number.isInteger(n)&&n>=0?n:null;}
function snapshotObject(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}

async function activateFullyDiscountedPayment({customerId,intentId,nonce,provider}){
    if(!customerId||!intentId||!nonce)throw new Error('Fully discounted checkout identity is incomplete.');
    let subscription;
    subscription=await transaction(async client=>{
        await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE',[customerId]);
        const intent=(await client.query('SELECT * FROM billing_checkout_intents WHERE id=$1 FOR UPDATE',[intentId])).rows[0];
        if(!intent)throw new Error('Checkout intent not found.');
        if(String(intent.customer_id)!==String(customerId)||intent.provider!==provider)throw new Error('Checkout intent belongs to a different account or provider.');
        if(intent.state!=='open'||new Date(intent.expires_at).getTime()<=Date.now())throw new Error('Checkout intent has expired or was already used.');
        if(checkoutIntents.hash(nonce)!==intent.nonce_hash)throw new Error('Checkout state verification failed.');
        if(String(intent.provider_checkout_id||'').trim())throw new Error('A provider checkout is already attached to this intent.');

        const snapshot=snapshotObject(intent.commercial_snapshot);
        if(snapshot.kind!=='direct_plan'||String(snapshot.planId||'')!==String(intent.plan_id||''))throw new Error('Checkout commercial snapshot is incomplete or does not match its plan.');
        if(snapshot.checkoutMode!=='payment')throw new Error('Only one-time checkouts can be settled locally when a discount covers the full price.');
        if(money(snapshot.discountedMinor)!==0||!snapshot.discountCodeId||!snapshot.discountReservationId)throw new Error('This checkout is not a fully discounted reserved purchase.');
        if(Number(snapshot.serviceCreditMinor||0)!==0)throw new Error('A fully discounted checkout cannot also consume service credit.');

        const plan=(await client.query('SELECT * FROM plans WHERE id=$1',[intent.plan_id])).rows[0];
        if(!plan)throw new Error('Plan not found.');
        await capacity.lockAndAssert(client,plan.id,snapshot.planName||plan.name||'This plan',{
            excludeCheckoutIntentId:intent.id,
            streams:snapshot.streams,
            households:snapshot.stremioHouseholdNetworkLimit
        });

        const startsAt=new Date(),endsAt=billingPeriods.addPlanDuration(snapshot,startsAt),storedSnapshot={...snapshot,checkoutIntentId:intent.id,settlementKind:'fully_discounted_local'};
        const inserted=await client.query(`INSERT INTO subscriptions(
            customer_id,plan_id,status,source,starts_at,current_period_end,cancel_at_period_end,
            plan_price_id_snapshot,provider_mapping_id_snapshot,provider_mapping_external_id_snapshot,
            plan_name_snapshot,plan_code_snapshot,price_minor_snapshot,currency_snapshot,
            billing_interval_snapshot,duration_days_snapshot,commercial_snapshot
        ) VALUES($1,$2,'active','manual',$3,$4,FALSE,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) RETURNING *`,[
            customerId,plan.id,startsAt,endsAt,snapshot.planPriceId||null,snapshot.providerMappingRecordId||null,
            snapshot.providerMappingId||null,snapshot.planName||plan.name,snapshot.planCode||plan.code,
            Number(snapshot.priceMinor||0),String(snapshot.currency||plan.currency||'').toUpperCase(),
            snapshot.billingInterval||plan.billing_interval,Number(snapshot.durationDays||plan.duration_days||30),JSON.stringify(storedSnapshot)
        ]);
        const row=inserted.rows[0];
        await discounts.redeemForSubscriptionTx(client,{
            discountCodeId:snapshot.discountCodeId,
            customerId,
            subscriptionId:row.id,
            amountAppliedMinor:Number(snapshot.priceMinor||0)
        });
        await client.query(`UPDATE billing_checkout_intents SET state='completed',completed_at=COALESCE(completed_at,NOW()),updated_at=NOW() WHERE id=$1`,[intent.id]);
        await checkoutIntents.settleReservation(client,intent.id,'completed');
        await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('payment.discount_fully_covered','subscription',$1,$2::jsonb)`,[row.id,JSON.stringify({customerId,planId:plan.id,checkoutIntentId:intent.id,discountCodeId:snapshot.discountCodeId,originalProvider:provider,amountDueMinor:0})]);
        return row;
    });
    await inactivityHolds.releaseObsoleteForCustomer(customerId);
    await lifecyclePrimitives.reconcileCommittedCustomer(customerId,'Fully discounted purchase');
    return subscription;
}

module.exports={activateFullyDiscountedPayment};
