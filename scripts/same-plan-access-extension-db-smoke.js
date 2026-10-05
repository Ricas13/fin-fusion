'use strict';

require('dotenv').config();
const assert=require('assert');
const {query,transaction,getPool}=require('../src/db');
const extensions=require('../src/payments/subscription-access-extensions');
const lifecyclePrimitives=require('../src/payments/lifecycle-primitives');
const checkoutIntents=require('../src/payments/checkout-intents');
const planCapacity=require('../src/entitlements/plan-capacity');

async function main(){
  const suffix=Date.now().toString(36);
  const server=(await query(`
    INSERT INTO jellyfin_servers(
      name,slug,server_class,media_server_type,base_url,api_key_encrypted,
      enabled,allow_new_users,paid_enabled,trial_enabled,priority,max_users,
      health_status,last_health_check,placement_mode
    ) VALUES($1,$2,'premium','jellyfin','https://extension-capacity.invalid','key',
      TRUE,TRUE,TRUE,TRUE,1,20,'healthy',NOW(),'active')
    RETURNING id
  `,[`Extension capacity ${suffix}`,`extension-capacity-${suffix}`])).rows[0];

  const plan=(await query(`
    INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class)
    VALUES($1,$1,'jellyfin','direct','month',30,600,'GBP',1,TRUE,TRUE,3,'premium')
    RETURNING *
  `,[`extension-plan-${suffix}`])).rows[0];
  await query('INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,100)',[plan.id,server.id]);
  const other=(await query(`
    INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class)
    VALUES($1,$1,'jellyfin','direct','month',30,600,'GBP',1,TRUE,TRUE,3,'premium')
    RETURNING *
  `,[`extension-other-${suffix}`])).rows[0];
  await query('INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,100)',[other.id,server.id]);
  const customer=(await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`,[`extension-${suffix}`,`extension-${suffix}@example.invalid`])).rows[0];
  const subscription=(await query(`
    INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,provider_subscription_id,starts_at,current_period_end,
      billing_interval_snapshot,duration_days_snapshot,service_type_snapshot)
    VALUES($1,$2,'active','stripe','subscription',$3,NOW(),'2030-01-31T00:00:00Z','month',30,'jellyfin')
    RETURNING *
  `,[customer.id,plan.id,`sub_extension_${suffix}`])).rows[0];

  const snapshot={kind:'subscription_extension',extensionSubscriptionId:subscription.id,planId:plan.id,planCode:plan.code,planName:plan.name,
    priceMinor:600,currency:'GBP',billingInterval:'month',durationDays:30,streams:3,accessVariantKind:'streams',accessQuantity:3,
    provider:'stripe',checkoutMode:'payment'};

  const extensionIntent=await checkoutIntents.createIntent({
    scope:'customer',customerId:customer.id,planId:plan.id,provider:'stripe',checkoutMode:'payment',ttlMinutes:30,
    commercialSnapshot:snapshot
  });
  const capacityWithExtensionCheckout=await planCapacity.usage(plan.id);
  assert.equal(Number(capacityWithExtensionCheckout.reserved||0),0,'an open extension checkout must not reserve another logical plan place');
  assert.equal(Number(capacityWithExtensionCheckout.planUsed||0),1,'the existing subscriber must remain the only occupied logical plan place');

  const first=await transaction(client=>extensions.applyPurchase(client,{
    customerId:customer.id,subscriptionId:subscription.id,planId:plan.id,provider:'stripe',
    providerPaymentId:`pi_extension_1_${suffix}`,checkoutIntentId:extensionIntent.id,commercialSnapshot:snapshot
  }));
  assert.equal(first.replay,false,'first extension must be new');
  assert.equal(Number(first.subscription.service_extension_days),28,'Jan 31 monthly extension must end on Feb 28, not assume a fixed 30-day month');
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM subscriptions WHERE customer_id=$1',[customer.id])).rows[0].n,1,'extension must not create a second subscription');

  const replay=await transaction(client=>extensions.applyPurchase(client,{
    customerId:customer.id,subscriptionId:subscription.id,planId:plan.id,provider:'stripe',
    providerPaymentId:`pi_extension_1_${suffix}`,checkoutIntentId:extensionIntent.id,commercialSnapshot:snapshot
  }));
  assert.equal(replay.replay,true,'provider replay must be idempotent');
  assert.equal(Number((await query('SELECT service_extension_days FROM subscriptions WHERE id=$1',[subscription.id])).rows[0].service_extension_days),28,'replay must not double-add time');

  await assert.rejects(
    transaction(client=>extensions.applyPurchase(client,{
      customerId:customer.id,subscriptionId:subscription.id,planId:plan.id,provider:'stripe',
      providerPaymentId:`pi_extension_different_${suffix}`,checkoutIntentId:extensionIntent.id,commercialSnapshot:snapshot
    })),
    error=>error?.code==='ACCESS_EXTENSION_PAYMENT_IDENTITY_CONFLICT',
    'the same checkout intent must never silently absorb a different provider payment'
  );

  await transaction(client=>extensions.applyPurchase(client,{
    customerId:customer.id,subscriptionId:subscription.id,planId:plan.id,provider:'paypal',
    providerPaymentId:`PAYPAL-EXT-2-${suffix}`,commercialSnapshot:snapshot
  }));
  assert.equal(Number((await query('SELECT service_extension_days FROM subscriptions WHERE id=$1',[subscription.id])).rows[0].service_extension_days),56,'independent monthly extensions must stack from Jan 31 -> Feb 28 -> Mar 28');

  const rebased=await lifecyclePrimitives.updateProviderSubscription({
    provider:'stripe',
    providerSubscriptionId:`sub_extension_${suffix}`,
    providerStatus:'active',
    periodEnd:'2030-02-28T00:00:00Z',
    cancelAtPeriodEnd:false
  });
  assert.equal(Number(rebased.service_extension_days),59,'provider renewal must rebase extensions from Feb 28 -> Mar 28 -> Apr 28 using calendar periods');

  const revoked=await extensions.revokeByProviderPayment({
    provider:'stripe',providerPaymentId:`pi_extension_1_${suffix}`,customerId:customer.id,reason:'test full refund',reference:'smoke'
  });
  assert.equal(revoked.changed,true,'confirmed reversal must remove the purchased extension');
  assert.equal(Number((await query('SELECT service_extension_days FROM subscriptions WHERE id=$1',[subscription.id])).rows[0].service_extension_days),28,'reversal must rebase the remaining monthly purchase from the earlier cursor');
  const revokedAgain=await extensions.revokeByProviderPayment({
    provider:'stripe',providerPaymentId:`pi_extension_1_${suffix}`,customerId:customer.id,reason:'duplicate refund',reference:'smoke-replay'
  });
  assert.equal(revokedAgain.changed,false,'reversal replay must be idempotent');
  assert.equal(Number((await query('SELECT service_extension_days FROM subscriptions WHERE id=$1',[subscription.id])).rows[0].service_extension_days),28,'duplicate reversal must not remove time twice');

  await query('UPDATE subscriptions SET status=\'cancelled\',current_period_end=NOW(),service_extension_days=0 WHERE id=$1',[subscription.id]);
  const restored=await extensions.restoreActivePurchasedDays(subscription.id,customer.id);
  assert(restored.purchasedDays>=28&&restored.purchasedDays<=31,'a separate base-term reversal must recompute the still-paid monthly extension from the new cursor');
  assert.equal(Number((await query('SELECT service_extension_days FROM subscriptions WHERE id=$1',[subscription.id])).rows[0].service_extension_days),restored.purchasedDays,'a base-term reversal must not erase independently paid extension time');

  await query("UPDATE subscriptions SET status='active',current_period_end='2030-02-28T00:00:00Z' WHERE id=$1",[subscription.id]);
  const pendingChange=(await query(`
    INSERT INTO customer_plan_changes(customer_id,current_subscription_id,target_plan_id,provider,mode,state,effective_at)
    VALUES($1,$2,$3,'stripe','period_end','pending','2030-02-28T00:00:00Z')
    RETURNING id
  `,[customer.id,subscription.id,other.id])).rows[0];
  await assert.rejects(
    transaction(client=>extensions.applyPurchase(client,{
      customerId:customer.id,subscriptionId:subscription.id,planId:plan.id,provider:'stripe',
      providerPaymentId:`pi_extension_pending_change_${suffix}`,commercialSnapshot:snapshot
    })),
    /plan change is already scheduled/i,
    'extension must fail closed while the current subscription has a pending plan change'
  );
  await query('DELETE FROM customer_plan_changes WHERE id=$1',[pendingChange.id]);

  await query(`UPDATE subscriptions SET commercial_snapshot=$2::jsonb WHERE id=$1`,[
    subscription.id,
    JSON.stringify({accessVariantKind:'streams',accessQuantity:5})
  ]);
  await assert.rejects(
    transaction(client=>extensions.applyPurchase(client,{
      customerId:customer.id,subscriptionId:subscription.id,planId:plan.id,provider:'stripe',
      providerPaymentId:`pi_extension_stale_allowance_${suffix}`,commercialSnapshot:snapshot
    })),
    /access allowance changed/i,
    'a checkout priced for an old access allowance must not extend a newly upgraded allowance'
  );
  await query(`UPDATE subscriptions SET commercial_snapshot='{}'::jsonb WHERE id=$1`,[subscription.id]);

  const collisionCustomer=(await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`,[`collision-${suffix}`,`collision-${suffix}@example.invalid`])).rows[0];
  await query(`
    INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,provider_subscription_id,starts_at,current_period_end,
      billing_interval_snapshot,duration_days_snapshot,service_type_snapshot)
    VALUES($1,$2,'active','stripe','payment',$3,NOW(),NOW()+INTERVAL '30 days','month',30,'jellyfin')
  `,[collisionCustomer.id,other.id,`pi_extension_collision_${suffix}`]);
  await assert.rejects(
    transaction(client=>extensions.applyPurchase(client,{
      customerId:customer.id,subscriptionId:subscription.id,planId:plan.id,provider:'stripe',
      providerPaymentId:`pi_extension_collision_${suffix}`,commercialSnapshot:snapshot
    })),
    /already attached to a subscription/i,
    'a provider payment already used by a normal subscription must not also buy extension time'
  );

  await assert.rejects(
    transaction(client=>extensions.applyPurchase(client,{
      customerId:customer.id,subscriptionId:subscription.id,planId:other.id,provider:'stripe',
      providerPaymentId:`pi_extension_wrong_${suffix}`,commercialSnapshot:{...snapshot,planId:other.id}
    })),
    /no longer matches your current plan/i,
    'forged plan/subscription combinations must fail closed'
  );

  const lateCustomer=(await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`,[`late-${suffix}`,`late-${suffix}@example.invalid`])).rows[0];
  const lateSubscription=(await query(`
    INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,
      billing_interval_snapshot,duration_days_snapshot,service_type_snapshot)
    VALUES($1,$2,'active','manual','manual',NOW()-INTERVAL '30 days',NOW()+INTERVAL '2 minutes','month',30,'jellyfin')
    RETURNING *
  `,[lateCustomer.id,plan.id])).rows[0];
  const lateSnapshot={...snapshot,extensionSubscriptionId:lateSubscription.id};
  const lateIntent=await checkoutIntents.createIntent({
    scope:'customer',customerId:lateCustomer.id,planId:plan.id,provider:'stripe',checkoutMode:'payment',ttlMinutes:30,
    commercialSnapshot:lateSnapshot
  });
  await query(`UPDATE subscriptions SET status='expired',current_period_end=NOW()-INTERVAL '1 minute' WHERE id=$1`,[lateSubscription.id]);
  await query(`UPDATE plans SET visible=FALSE WHERE id=$1`,[plan.id]);
  const lateSettled=await transaction(client=>extensions.applyPurchase(client,{
    customerId:lateCustomer.id,subscriptionId:lateSubscription.id,planId:plan.id,provider:'stripe',
    providerPaymentId:`pi_extension_late_${suffix}`,checkoutIntentId:lateIntent.id,commercialSnapshot:lateSnapshot
  }));
  assert.equal(lateSettled.replay,false,'a verified extension paid just after natural expiry must still fulfill instead of becoming paid-but-unfulfilled');
  assert(Number(lateSettled.subscription.service_extension_days)>0,'late settlement must add the purchased extension time');
  await query(`UPDATE plans SET visible=TRUE WHERE id=$1`,[plan.id]);

  const ledger=await query('SELECT provider,provider_payment_id,purchased_days,applied_days,status FROM subscription_access_extensions WHERE customer_id=$1 ORDER BY created_at',[customer.id]);
  assert.equal(ledger.rowCount,2,'each real extension payment must have one durable ledger row');
  assert.equal(ledger.rows.filter(row=>row.status==='active').length,1,'only the non-refunded extension should remain active');
  assert.equal(Number(ledger.rows.find(row=>row.status==='revoked')?.applied_days||0),0,'a revoked payment must retain purchase history without remaining in the aggregate applied-day contribution');

  const baselineCustomer=(await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`,[`baseline-${suffix}`,`baseline-${suffix}@example.invalid`])).rows[0];
  const baselineSubscription=(await query(`
    INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,service_extension_days,
      billing_interval_snapshot,duration_days_snapshot,service_type_snapshot)
    VALUES($1,$2,'active','manual','manual','2029-12-31T00:00:00Z','2030-01-31T00:00:00Z',7,'month',30,'jellyfin')
    RETURNING *
  `,[baselineCustomer.id,plan.id])).rows[0];
  const baselineSnapshot={...snapshot,extensionSubscriptionId:baselineSubscription.id};
  const baselinePurchase=await transaction(client=>extensions.applyPurchase(client,{
    customerId:baselineCustomer.id,subscriptionId:baselineSubscription.id,planId:plan.id,provider:'stripe',
    providerPaymentId:`pi_extension_baseline_${suffix}`,commercialSnapshot:baselineSnapshot
  }));
  assert(Number(baselinePurchase.subscription.service_extension_days)>7,'paid extension must stack after unrelated/manual extension days');
  await extensions.revokeByProviderPayment({
    provider:'stripe',providerPaymentId:`pi_extension_baseline_${suffix}`,customerId:baselineCustomer.id,reason:'baseline refund',reference:'baseline-smoke'
  });
  assert.equal(Number((await query('SELECT service_extension_days FROM subscriptions WHERE id=$1',[baselineSubscription.id])).rows[0].service_extension_days),7,'refund must remove only purchased time and preserve unrelated/manual extension days');
  await query("UPDATE subscriptions SET current_period_end='2030-02-28T00:00:00Z' WHERE id=$1",[baselineSubscription.id]);
  const baselineRecomputed=await transaction(client=>extensions.recomputeActivePurchasedDaysTx(client,baselineSubscription.id,baselineCustomer.id));
  assert.equal(Number(baselineRecomputed.subscription.service_extension_days),7,'later rebasing must not subtract a revoked extension from unrelated/manual extension days a second time');

  console.log('same-plan access extension smoke: ok — additive, no capacity subscription duplication, replay-safe and refund-safe');
}

main().then(()=>getPool().end()).catch(async error=>{console.error(error.stack||error);try{await getPool().end();}catch(_){}process.exit(1);});
