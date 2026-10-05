'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const billingPeriods = require('../src/payments/billing-periods');
const extensions = require('../src/payments/subscription-extensions');
const intents = require('../src/payments/checkout-intents');
const capacity = require('../src/entitlements/plan-capacity');
const incidents = require('../src/payments/incidents');

function ms(value){ return new Date(value).getTime(); }
function addDays(value,days){ return new Date(ms(value)+Number(days)*86400000); }
function extensionSnapshot(plan,subscriptionId,provider='stripe'){
  return {
    kind:'direct_plan',
    purchaseKind:'subscription_extension',
    extensionSubscriptionId:String(subscriptionId),
    planId:String(plan.id),
    planPriceId:null,
    planCode:plan.code,
    planName:plan.name,
    accessVariantId:null,
    accessVariantKind:'streams',
    accessQuantity:1,
    priceMinor:Number(plan.price_minor),
    currency:'GBP',
    billingInterval:'month',
    durationDays:30,
    streams:1,
    stremioHouseholdNetworkLimit:1,
    provider,
    checkoutMode:'payment',
    providerMappingId:null,
    providerMappingRecordId:null,
    discountedMinor:Number(plan.price_minor)
  };
}

async function main(){
  const suffix=crypto.randomBytes(6).toString('hex');
  const server=(await query(`
    INSERT INTO jellyfin_servers(
      name,slug,server_class,media_server_type,base_url,api_key_encrypted,
      enabled,allow_new_users,paid_enabled,trial_enabled,priority,max_users,
      health_status,last_health_check,placement_mode
    ) VALUES($1,$2,'premium','jellyfin','https://extension.invalid','key',
      TRUE,TRUE,TRUE,TRUE,1,1,'healthy',NOW(),'active')
    RETURNING id
  `,[`Extension ${suffix}`,`extension-${suffix}`])).rows[0];

  const plan=(await query(`
    INSERT INTO plans(
      code,name,description,service_type,audience,billing_interval,duration_days,
      price_minor,currency,capacity_limit,inactivity_policy,is_addon,server_class,
      visible,active,streams
    ) VALUES($1,$2,'same-plan extension smoke','jellyfin','direct','month',30,
      600,'GBP',1,$3::jsonb,FALSE,'premium',TRUE,TRUE,1)
    RETURNING *
  `,[`extension-plan-${suffix}`,`Extension plan ${suffix}`,JSON.stringify({mediaCapacityManaged:true})])).rows[0];
  await query('INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,100)',[plan.id,server.id]);
  const price=(await query(`
    INSERT INTO plan_prices(plan_id,currency,price_minor,active,is_default)
    VALUES($1,'GBP',600,TRUE,TRUE)
    ON CONFLICT(plan_id,currency) DO UPDATE SET price_minor=EXCLUDED.price_minor,active=TRUE
    RETURNING *
  `,[plan.id])).rows[0];

  const customer=(await query(
    'INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *',
    [`Extension customer ${suffix}`,`extension-${suffix}@example.invalid`]
  )).rows[0];

  const baseEnd=addDays(new Date(),10);
  const subscription=(await query(`
    INSERT INTO subscriptions(
      customer_id,plan_id,status,source,billing_mode,provider_subscription_id,
      starts_at,current_period_end,service_extension_days,
      plan_name_snapshot,plan_code_snapshot,price_minor_snapshot,currency_snapshot,
      billing_interval_snapshot,duration_days_snapshot,service_type_snapshot,
      commercial_snapshot
    ) VALUES(
      $1,$2,'active','stripe','subscription',$3,
      NOW()-INTERVAL '1 day',$4,5,
      $5,$6,600,'GBP','month',30,'jellyfin',$7::jsonb
    ) RETURNING *
  `,[
    customer.id,plan.id,`sub_extension_${suffix}`,baseEnd,plan.name,plan.code,
    JSON.stringify({kind:'direct_plan',planId:plan.id,planCode:plan.code,planName:plan.name,accessVariantKind:'streams',accessQuantity:1,billingInterval:'month',durationDays:30,priceMinor:600,currency:'GBP',provider:'stripe',checkoutMode:'subscription'})
  ])).rows[0];

  await query(`
    INSERT INTO jellyfin_accounts(
      customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,
      account_purpose,access_lane,is_primary
    ) VALUES($1,$2,$3,$4,FALSE,'jellyfin','primary',TRUE)
  `,[customer.id,server.id,`remote-${suffix}`,`extension_${suffix}`]);

  const saturated=await capacity.usage(plan.id);
  assert.equal(saturated.remaining,0,'fixture must start with the only server/plan place occupied by the current subscriber');

  const choice=await extensions.checkoutChoice({
    customerId:customer.id,
    subscriptionId:subscription.id,
    planCode:plan.code,
    provider:'plisio',
    currency:'GBP'
  });
  assert.equal(choice.mode,'payment','extension resolver must force one-time checkout');
  assert.equal(String(choice.extensionSubscriptionId),String(subscription.id));
  assert.equal(String(choice.plan.plan_price_id),String(price.id));
  assert.equal(Number(choice.plan.price_minor),600);

  const firstSnapshot=extensionSnapshot(plan,subscription.id,'stripe');
  const manualBaseEnd=addDays(baseEnd,5);
  const expectedFirstEnd=billingPeriods.addPlanDuration({billing_interval:'month',duration_days:30},manualBaseEnd);
  const first=await extensions.activatePaidExtension({
    customerId:customer.id,
    planId:plan.id,
    provider:'stripe',
    providerPaymentId:`pi_extension_1_${suffix}`,
    commercialSnapshot:firstSnapshot
  });
  assert.equal(ms(first.accessExpiresAt),ms(expectedFirstEnd),'first purchase must append one calendar month after all already-owned time');
  assert.equal(Number(first.subscription.service_extension_days),5+extensions.wholeDaysBetween(manualBaseEnd,expectedFirstEnd),'existing non-purchase extension days must be preserved');

  const replay=await extensions.activatePaidExtension({
    customerId:customer.id,
    planId:plan.id,
    provider:'stripe',
    providerPaymentId:`pi_extension_1_${suffix}`,
    commercialSnapshot:firstSnapshot
  });
  assert.equal(replay.alreadyApplied,true,'provider callback replay must be idempotent');
  assert.equal(Number((await query('SELECT COUNT(*)::int n FROM subscription_service_extension_events WHERE source=$1 AND reference_id=$2',[extensions.eventSource('stripe'),`pi_extension_1_${suffix}`])).rows[0].n),1,'replay must not duplicate extension ledger rows');
  assert.equal(Number((await query('SELECT COUNT(*)::int n FROM subscriptions WHERE customer_id=$1',[customer.id])).rows[0].n),1,'extension purchase must not create a second subscription');

  const renewalEnd=billingPeriods.addPlanDuration({billing_interval:'month',duration_days:30},baseEnd);
  await query('UPDATE subscriptions SET current_period_end=$2 WHERE id=$1',[subscription.id,renewalEnd]);
  const rebased=await extensions.recompute(subscription.id);
  const rebasedManualEnd=addDays(renewalEnd,5);
  const expectedRebased=billingPeriods.addPlanDuration({billing_interval:'month',duration_days:30},rebasedManualEnd);
  assert.equal(ms(rebased.accessExpiresAt),ms(expectedRebased),'provider renewal must move the purchased extension after the new provider-paid period');
  assert.equal(Number(rebased.serviceExtensionDays),5+extensions.wholeDaysBetween(rebasedManualEnd,expectedRebased),'renewal rebase must retain unrelated manual extension days');

  const second=await extensions.activatePaidExtension({
    customerId:customer.id,
    planId:plan.id,
    provider:'paypal',
    providerPaymentId:`CAPTURE-EXTENSION-2-${suffix}`,
    commercialSnapshot:{...extensionSnapshot(plan,subscription.id,'paypal')}
  });
  const expectedSecond=billingPeriods.addPlanDuration({billing_interval:'month',duration_days:30},expectedRebased);
  assert.equal(ms(second.accessExpiresAt),ms(expectedSecond),'a second purchase must queue another full calendar month');

  const revoked=await extensions.revokeProviderPayment({
    customerId:customer.id,
    provider:'paypal',
    providerPaymentId:`CAPTURE-EXTENSION-2-${suffix}`,
    reason:'DB smoke full refund',
    incidentId:null
  });
  assert.equal(revoked.changed,true,'full payment loss must revoke the exact purchased extension');
  assert.equal(ms(revoked.accessExpiresAt),ms(expectedRebased),'refunding the second purchase must leave the first purchased month intact');
  const refundedEvent=(await query('SELECT metadata FROM subscription_service_extension_events WHERE source=$1 AND reference_id=$2',[extensions.eventSource('paypal'),`CAPTURE-EXTENSION-2-${suffix}`])).rows[0];
  assert.equal(refundedEvent.metadata.refunded,true,'revoked extension event must remain as auditable refunded history');
  assert.equal(Number(refundedEvent.metadata.appliedDays),0,'refunded extension must contribute zero active service days');

  const third=await extensions.activatePaidExtension({
    customerId:customer.id,
    planId:plan.id,
    provider:'stripe',
    providerPaymentId:`pi_extension_incident_${suffix}`,
    commercialSnapshot:firstSnapshot
  });
  const expectedThird=billingPeriods.addPlanDuration({billing_interval:'month',duration_days:30},expectedRebased);
  assert.equal(ms(third.accessExpiresAt),ms(expectedThird),'incident fixture must add one exact extension period');
  const extensionLoss=await incidents.record({
    provider:'stripe',
    eventId:`evt_extension_refund_${suffix}`,
    caseId:`ch_extension_refund_${suffix}`,
    kind:'refund',
    status:'recorded',
    identity:{scope:'direct',customerId:customer.id},
    providerSubscriptionId:`pi_extension_incident_${suffix}`,
    amountMinor:600,
    currency:'GBP',
    metadata:{fullRefund:true,originalAmountMinor:600}
  });
  assert.equal(extensionLoss.extensionPaymentLoss,true,'payment incident must classify an exact paid-extension loss');
  const afterIncident=(await query('SELECT status,service_extension_days FROM subscriptions WHERE id=$1',[subscription.id])).rows[0];
  assert.equal(afterIncident.status,'active','extension refund must not terminate the underlying recurring subscription');
  const afterIncidentAccess=await extensions.recompute(subscription.id);
  assert.equal(ms(afterIncidentAccess.accessExpiresAt),ms(expectedRebased),'extension refund incident must remove only the time bought by its exact payment');

  const extensionIntentSnapshot={...extensionSnapshot(plan,subscription.id,'stripe'),planPriceId:price.id};
  const extensionIntent=await intents.createIntent({
    scope:'customer',
    customerId:customer.id,
    planId:plan.id,
    planPriceId:price.id,
    provider:'stripe',
    checkoutMode:'payment',
    commercialSnapshot:extensionIntentSnapshot
  });
  assert(extensionIntent.id,'current subscriber must be able to open an extension checkout even when the plan is physically full');
  const whileHeld=await capacity.usage(plan.id);
  assert.equal(whileHeld.reservedUsers,0,'extension checkout must not reserve another media-server place');
  assert.equal(whileHeld.remaining,0,'extension checkout must not manufacture or consume capacity');

  const other=(await query(
    'INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *',
    [`Other extension customer ${suffix}`,`other-extension-${suffix}@example.invalid`]
  )).rows[0];
  await assert.rejects(
    ()=>intents.createIntent({
      scope:'customer',
      customerId:other.id,
      planId:plan.id,
      planPriceId:price.id,
      provider:'stripe',
      checkoutMode:'payment',
      commercialSnapshot:{
        kind:'direct_plan',purchaseKind:'plan_purchase',planId:plan.id,planPriceId:price.id,
        planCode:plan.code,planName:plan.name,priceMinor:600,currency:'GBP',
        billingInterval:'month',durationDays:30,streams:1,stremioHouseholdNetworkLimit:1,
        provider:'stripe',checkoutMode:'payment',discountedMinor:600
      }
    }),
    error=>error?.code==='PLAN_CAPACITY_EXHAUSTED',
    'a genuinely new customer must still be blocked by the same saturated plan'
  );

  await intents.consume({intentId:extensionIntent.id,nonce:extensionIntent.nonce,state:'cancelled',scope:'customer',provider:'stripe',ownerId:customer.id});

  console.log('subscription extension DB smoke: ok — no duplicate subscription/capacity, calendar stacking, renewal rebase, idempotency, exact refund reversal and underlying-subscription preservation');
}

main().then(()=>getPool().end()).catch(async error=>{
  console.error(error.stack||error);
  try{await getPool().end();}catch(_){}
  process.exit(1);
});
