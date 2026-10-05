'use strict';

require('dotenv').config();
const assert=require('assert');
const {query,transaction,getPool}=require('../src/db');
const extensions=require('../src/payments/subscription-access-extensions');

async function main(){
  const suffix=Date.now().toString(36);
  const plan=(await query(`
    INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class)
    VALUES($1,$1,'jellyfin','direct','month',30,600,'GBP',1,TRUE,TRUE,3,'premium')
    RETURNING *
  `,[`extension-plan-${suffix}`])).rows[0];
  const other=(await query(`
    INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class)
    VALUES($1,$1,'jellyfin','direct','month',30,600,'GBP',1,TRUE,TRUE,3,'premium')
    RETURNING *
  `,[`extension-other-${suffix}`])).rows[0];
  const customer=(await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`,[`extension-${suffix}`,`extension-${suffix}@example.invalid`])).rows[0];
  const subscription=(await query(`
    INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,provider_subscription_id,starts_at,current_period_end,
      billing_interval_snapshot,duration_days_snapshot,service_type_snapshot,streams_snapshot)
    VALUES($1,$2,'active','stripe','subscription',$3,NOW()-INTERVAL '5 days',NOW()+INTERVAL '25 days','month',30,'jellyfin',3)
    RETURNING *
  `,[customer.id,plan.id,`sub_extension_${suffix}`])).rows[0];

  const snapshot={kind:'subscription_extension',extensionSubscriptionId:subscription.id,planId:plan.id,planCode:plan.code,planName:plan.name,
    priceMinor:600,currency:'GBP',billingInterval:'month',durationDays:30,streams:3,accessVariantKind:'streams',accessQuantity:3,
    provider:'stripe',checkoutMode:'payment'};

  const first=await transaction(client=>extensions.applyPurchase(client,{
    customerId:customer.id,subscriptionId:subscription.id,planId:plan.id,provider:'stripe',
    providerPaymentId:`pi_extension_1_${suffix}`,commercialSnapshot:snapshot
  }));
  assert.equal(first.replay,false,'first extension must be new');
  assert.equal(Number(first.subscription.service_extension_days),30,'first extension must add exactly one plan duration');
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM subscriptions WHERE customer_id=$1',[customer.id])).rows[0].n,1,'extension must not create a second subscription');

  const replay=await transaction(client=>extensions.applyPurchase(client,{
    customerId:customer.id,subscriptionId:subscription.id,planId:plan.id,provider:'stripe',
    providerPaymentId:`pi_extension_1_${suffix}`,commercialSnapshot:snapshot
  }));
  assert.equal(replay.replay,true,'provider replay must be idempotent');
  assert.equal(Number((await query('SELECT service_extension_days FROM subscriptions WHERE id=$1',[subscription.id])).rows[0].service_extension_days),30,'replay must not double-add time');

  await transaction(client=>extensions.applyPurchase(client,{
    customerId:customer.id,subscriptionId:subscription.id,planId:plan.id,provider:'paypal',
    providerPaymentId:`PAYPAL-EXT-2-${suffix}`,commercialSnapshot:snapshot
  }));
  assert.equal(Number((await query('SELECT service_extension_days FROM subscriptions WHERE id=$1',[subscription.id])).rows[0].service_extension_days),60,'independent extension purchases must stack');

  const revoked=await extensions.revokeByProviderPayment({
    provider:'stripe',providerPaymentId:`pi_extension_1_${suffix}`,customerId:customer.id,reason:'test full refund',reference:'smoke'
  });
  assert.equal(revoked.changed,true,'confirmed reversal must remove the purchased extension');
  assert.equal(Number((await query('SELECT service_extension_days FROM subscriptions WHERE id=$1',[subscription.id])).rows[0].service_extension_days),30,'reversal must remove only its own purchased days');
  const revokedAgain=await extensions.revokeByProviderPayment({
    provider:'stripe',providerPaymentId:`pi_extension_1_${suffix}`,customerId:customer.id,reason:'duplicate refund',reference:'smoke-replay'
  });
  assert.equal(revokedAgain.changed,false,'reversal replay must be idempotent');
  assert.equal(Number((await query('SELECT service_extension_days FROM subscriptions WHERE id=$1',[subscription.id])).rows[0].service_extension_days),30,'duplicate reversal must not remove time twice');

  await assert.rejects(
    transaction(client=>extensions.applyPurchase(client,{
      customerId:customer.id,subscriptionId:subscription.id,planId:other.id,provider:'stripe',
      providerPaymentId:`pi_extension_wrong_${suffix}`,commercialSnapshot:{...snapshot,planId:other.id}
    })),
    /no longer matches your current plan/i,
    'forged plan/subscription combinations must fail closed'
  );

  const ledger=await query('SELECT provider,provider_payment_id,purchased_days,status FROM subscription_access_extensions WHERE customer_id=$1 ORDER BY created_at',[customer.id]);
  assert.equal(ledger.rowCount,2,'each real extension payment must have one durable ledger row');
  assert.equal(ledger.rows.filter(row=>row.status==='active').length,1,'only the non-refunded extension should remain active');

  console.log('same-plan access extension smoke: ok — additive, no capacity subscription duplication, replay-safe and refund-safe');
}

main().then(()=>getPool().end()).catch(async error=>{console.error(error.stack||error);try{await getPool().end();}catch(_){}process.exit(1);});
