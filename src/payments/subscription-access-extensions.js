'use strict';

const { transaction } = require('../db');

const PROVIDERS=new Set(['stripe','paypal','plisio']);
const LIVE_STATUSES=new Set(['active','trialing','past_due','paused','cancelled']);

function cleanProvider(value){
  const provider=String(value||'').trim().toLowerCase();
  if(!PROVIDERS.has(provider))throw new Error('Unsupported access-extension payment provider.');
  return provider;
}
function cleanReference(value,label='Payment reference'){
  const reference=String(value||'').trim();
  if(!reference)throw new Error(`${label} is required.`);
  return reference;
}
function purchasedDays(snapshot={}){
  const days=Number(snapshot?.durationDays);
  if(!Number.isInteger(days)||days<1||days>3650)throw new Error('This plan does not have a valid extension duration.');
  return days;
}
async function lockedTarget(client,{customerId,subscriptionId,planId}){
  const result=await client.query(`
    SELECT s.*,p.name AS plan_name,p.code AS plan_code,p.price_minor,p.is_free_tier,p.is_addon,p.billing_interval,
           COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') AS effective_service_type
      FROM subscriptions s
      JOIN plans p ON p.id=s.plan_id
     WHERE s.id=$1 AND s.customer_id=$2
     FOR UPDATE OF s
  `,[subscriptionId,customerId]);
  const row=result.rows[0]||null;
  if(!row)throw new Error('The subscription being extended no longer exists.');
  if(String(row.plan_id)!==String(planId))throw new Error('The selected extension no longer matches your current plan.');
  if(row.superseded_by)throw new Error('This subscription has already been replaced.');
  if(row.is_addon||row.is_free_tier||Number(row.price_minor||0)<=0||String(row.billing_interval||'')==='trial')throw new Error('Only a current paid plan can be extended.');
  if(!LIVE_STATUSES.has(String(row.status||'')))throw new Error('This paid plan is no longer current.');
  const accessEnd=new Date(row.current_period_end||0).getTime()+Math.max(0,Number(row.service_extension_days||0))*86400000;
  if(!Number.isFinite(accessEnd)||accessEnd<=Date.now())throw new Error('This paid plan has already expired.');
  return row;
}
async function existingExtension(client,{provider,providerPaymentId,checkoutIntentId}){
  const result=await client.query(`
    SELECT *
      FROM subscription_access_extensions
     WHERE (provider=$1 AND provider_payment_id=$2)
        OR ($3::uuid IS NOT NULL AND checkout_intent_id=$3)
     ORDER BY created_at DESC
     LIMIT 1
     FOR UPDATE
  `,[provider,providerPaymentId,checkoutIntentId||null]);
  return result.rows[0]||null;
}
async function applyPurchase(client,{customerId,subscriptionId,planId,provider,providerPaymentId,checkoutIntentId=null,commercialSnapshot={}}){
  if(!client||typeof client.query!=='function')throw new Error('Access extension requires an active database transaction.');
  provider=cleanProvider(provider);
  providerPaymentId=cleanReference(providerPaymentId);
  subscriptionId=cleanReference(subscriptionId,'Subscription');
  const target=await lockedTarget(client,{customerId,subscriptionId,planId});
  const days=purchasedDays(commercialSnapshot);
  if(Number(target.service_extension_days||0)+days>3650)throw new Error('This subscription cannot be extended beyond the maximum supported paid-through window.');
  const prior=await existingExtension(client,{provider,providerPaymentId,checkoutIntentId});
  if(prior){
    if(String(prior.customer_id)!==String(customerId)||String(prior.subscription_id)!==String(subscriptionId)||String(prior.plan_id)!==String(planId)){
      const error=new Error('This provider payment is already attached to a different access extension.');
      error.code='ACCESS_EXTENSION_PAYMENT_IDENTITY_CONFLICT';
      throw error;
    }
    return{subscription:target,extension:prior,replay:true};
  }
  const inserted=(await client.query(`
    INSERT INTO subscription_access_extensions(
      customer_id,subscription_id,plan_id,provider,provider_payment_id,checkout_intent_id,
      purchased_days,commercial_snapshot
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
    RETURNING *
  `,[customerId,subscriptionId,planId,provider,providerPaymentId,checkoutIntentId||null,days,JSON.stringify(commercialSnapshot||{})])).rows[0];
  const updated=(await client.query(`
    UPDATE subscriptions
       SET service_extension_days=COALESCE(service_extension_days,0)+$2,
           updated_at=NOW()
     WHERE id=$1
     RETURNING *
  `,[subscriptionId,days])).rows[0];
  await client.query(`
    INSERT INTO audit_log(action,entity_type,entity_id,metadata)
    VALUES('subscription.access_extension.purchase','subscription',$1,$2::jsonb)
  `,[subscriptionId,JSON.stringify({customerId,planId,provider,providerPaymentId,checkoutIntentId,purchasedDays:days,extensionId:inserted.id})]);
  return{subscription:updated,extension:inserted,replay:false};
}
async function extensionIdentity(provider,providerPaymentId){
  provider=cleanProvider(provider);providerPaymentId=cleanReference(providerPaymentId);
  const { query }=require('../db');
  const result=await query(`
    SELECT customer_id,subscription_id,plan_id,status,purchased_days
      FROM subscription_access_extensions
     WHERE provider=$1 AND provider_payment_id=$2
     LIMIT 1
  `,[provider,providerPaymentId]);
  return result.rows[0]||null;
}
async function revokeByProviderPayment({provider,providerPaymentId,customerId=null,reason='Provider payment was reversed',reference=null}){
  provider=cleanProvider(provider);providerPaymentId=cleanReference(providerPaymentId);
  return transaction(async client=>{
    const extension=(await client.query(`
      SELECT * FROM subscription_access_extensions
       WHERE provider=$1 AND provider_payment_id=$2
       LIMIT 1
       FOR UPDATE
    `,[provider,providerPaymentId])).rows[0]||null;
    if(!extension)return{matched:false,changed:false,customerId:null,subscriptionId:null};
    if(customerId&&String(extension.customer_id)!==String(customerId)){
      const error=new Error('Access-extension payment belongs to a different customer.');
      error.code='ACCESS_EXTENSION_CUSTOMER_MISMATCH';
      throw error;
    }
    if(extension.status==='revoked')return{matched:true,changed:false,customerId:extension.customer_id,subscriptionId:extension.subscription_id,extension};
    const locked=(await client.query('SELECT id,customer_id,service_extension_days FROM subscriptions WHERE id=$1 AND customer_id=$2 FOR UPDATE',[extension.subscription_id,extension.customer_id])).rows[0]||null;
    if(!locked)throw new Error('The subscription attached to this access extension no longer exists.');
    const days=Math.max(0,Number(extension.purchased_days||0));
    const updated=(await client.query(`
      UPDATE subscriptions
         SET service_extension_days=GREATEST(0,COALESCE(service_extension_days,0)-$2),
             updated_at=NOW()
       WHERE id=$1
       RETURNING *
    `,[extension.subscription_id,days])).rows[0];
    const revoked=(await client.query(`
      UPDATE subscription_access_extensions
         SET status='revoked',revoked_at=COALESCE(revoked_at,NOW()),
             revoke_reason=COALESCE(NULLIF($2,''),revoke_reason),updated_at=NOW()
       WHERE id=$1
       RETURNING *
    `,[extension.id,String(reason||'').slice(0,1000)])).rows[0];
    await client.query(`
      INSERT INTO audit_log(action,entity_type,entity_id,metadata)
      VALUES('subscription.access_extension.revoke','subscription',$1,$2::jsonb)
    `,[extension.subscription_id,JSON.stringify({customerId:extension.customer_id,provider,providerPaymentId,purchasedDays:days,extensionId:extension.id,reference:reference||null,reason:String(reason||'').slice(0,500)})]);
    return{matched:true,changed:true,customerId:extension.customer_id,subscriptionId:extension.subscription_id,extension:revoked,subscription:updated};
  });
}

module.exports={PROVIDERS,LIVE_STATUSES,cleanProvider,cleanReference,purchasedDays,lockedTarget,applyPurchase,extensionIdentity,revokeByProviderPayment};
