'use strict';
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { query, transaction, getPool } = require('../src/db');
const extensions = require('../src/payments/subscription-access-extensions');
const subscriptionState = require('../src/entitlements/subscription-state');
const refunds = require('../src/payments/prorata-refunds');
const refundLifecycle = require('../src/payments/lifecycle-prepaid-refunds');

const source = file => fs.readFileSync(path.join(__dirname,'..',file),'utf8');

async function main() {
  const suffix = Date.now().toString(36);
  const customer = (await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`, [`Prorata ${suffix}`,`prorata-${suffix}@example.invalid`])).rows[0];
  const plan = (await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class)
    VALUES($1,'Prorata annual','jellyfin','direct','year',365,5000,'GBP',100,TRUE,TRUE,1,'premium') RETURNING *`, [`prorata-${suffix}`])).rows[0];
  const subscription = (await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,price_minor_snapshot,currency_snapshot,plan_name_snapshot,service_type_snapshot,commercial_snapshot)
    VALUES($1,$2,'active','stripe',$3,NOW()-INTERVAL '30 days',NOW()+INTERVAL '30 days',5000,'GBP','Prorata annual','jellyfin',$4::jsonb) RETURNING *`, [customer.id,plan.id,`pi_prorata_${suffix}`,JSON.stringify({priceMinor:5000,discountedMinor:4000,serviceCreditMinor:1000,currency:'GBP',checkoutMode:'payment'})])).rows[0];

  const quote = await refunds.quote(subscription.id);
  assert.equal(quote.providerPaidMinor, 4000, 'quote must use actual provider cash, not £50 service value');
  assert.equal(quote.serviceCreditMinor, 1000, 'quote must expose excluded affiliate/service credit');
  assert(Math.abs(quote.refundMinor - 2000) <= 2, `half-unused service should refund about £20 provider cash, got ${quote.refundMinor}`);

  await query(`INSERT INTO payment_incidents(provider,provider_event_id,provider_case_id,incident_type,incident_status,scope,customer_id,provider_subscription_id,amount_minor,currency,access_action,metadata)
    VALUES('stripe',$1,$2,'refund','recorded','direct',$3,$4,500,'GBP','preserve',$5::jsonb)`, [`evt_prorata_prior_${suffix}`,`re_prior_${suffix}`,customer.id,subscription.provider_subscription_id,JSON.stringify({originalAmountMinor:4000,fullRefund:false})]);
  const afterPrior = await refunds.quote(subscription.id);
  assert(Math.abs(afterPrior.refundMinor - 1500) <= 2, `prior £5 refund must reduce remaining pro-rata cash allowance, got ${afterPrior.refundMinor}`);

  const queued = (await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,price_minor_snapshot,currency_snapshot,service_type_snapshot,commercial_snapshot)
    VALUES($1,$2,'active','stripe',$3,$4,$4::timestamptz+INTERVAL '30 days',4000,'GBP','jellyfin',$5::jsonb) RETURNING *`, [customer.id,plan.id,`pi_prorata_queue_${suffix}`,subscription.current_period_end,JSON.stringify({discountedMinor:4000,currency:'GBP',checkoutMode:'payment'})])).rows[0];
  const cutoffAt = new Date();
  const applied = await refundLifecycle.applyPrepaidRefund({subscriptionId:subscription.id,customerId:customer.id,originalEnd:subscription.current_period_end,cutoffAt,serviceType:'jellyfin'});
  assert(applied.removedMs > 0, 'first lifecycle application must remove the unused service span');
  const shiftedOnce = (await query('SELECT starts_at,current_period_end FROM subscriptions WHERE id=$1',[queued.id])).rows[0];
  assert(Math.abs(new Date(shiftedOnce.starts_at).getTime()-cutoffAt.getTime()) < 1000, 'queued prepaid access must move forward to the refund cutoff');
  const retry = await refundLifecycle.applyPrepaidRefund({subscriptionId:subscription.id,customerId:customer.id,originalEnd:subscription.current_period_end,cutoffAt,serviceType:'jellyfin'});
  assert.equal(retry.removedMs,0,'recovery after local commit must not remove the same service span twice');
  const shiftedTwice = (await query('SELECT starts_at,current_period_end FROM subscriptions WHERE id=$1',[queued.id])).rows[0];
  assert.equal(new Date(shiftedTwice.starts_at).getTime(),new Date(shiftedOnce.starts_at).getTime(),'retry must not shift queued prepaid periods twice');

  // The provider refund webhook may arrive before provider-operation recovery.
  // The existing payment_incident trigger owns full future refunds, so the
  // operation-side lifecycle must recognize that state and never compact the
  // later prepaid queue a second time.
  const future = (await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,price_minor_snapshot,currency_snapshot,service_type_snapshot,commercial_snapshot)
    VALUES($1,$2,'active','stripe',$3,NOW()+INTERVAL '60 days',NOW()+INTERVAL '90 days',4000,'GBP','jellyfin',$4::jsonb) RETURNING *`, [customer.id,plan.id,`pi_prorata_future_${suffix}`,JSON.stringify({discountedMinor:4000,currency:'GBP',checkoutMode:'payment'})])).rows[0];
  const futureLater = (await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,price_minor_snapshot,currency_snapshot,service_type_snapshot,commercial_snapshot)
    VALUES($1,$2,'active','stripe',$3,$4,$4::timestamptz+INTERVAL '30 days',4000,'GBP','jellyfin',$5::jsonb) RETURNING *`, [customer.id,plan.id,`pi_prorata_future_later_${suffix}`,future.current_period_end,JSON.stringify({discountedMinor:4000,currency:'GBP',checkoutMode:'payment'})])).rows[0];
  await query(`INSERT INTO payment_incidents(provider,provider_event_id,provider_case_id,incident_type,incident_status,scope,customer_id,provider_subscription_id,amount_minor,currency,access_action,metadata)
    VALUES('stripe',$1,$2,'refund','recorded','direct',$3,$4,4000,'GBP','preserve',$5::jsonb)`, [`evt_prorata_future_${suffix}`,`re_future_${suffix}`,customer.id,future.provider_subscription_id,JSON.stringify({originalAmountMinor:4000,fullRefund:true})]);
  const futureAfterWebhook = (await query('SELECT status FROM subscriptions WHERE id=$1',[future.id])).rows[0];
  assert.equal(futureAfterWebhook.status,'expired','full future refund incident must expire the exact unused entitlement');
  const laterAfterWebhook = (await query('SELECT starts_at,current_period_end FROM subscriptions WHERE id=$1',[futureLater.id])).rows[0];
  const webhookRaceRetry = await refundLifecycle.applyPrepaidRefund({subscriptionId:future.id,customerId:customer.id,originalEnd:future.current_period_end,cutoffAt:future.starts_at,serviceType:'jellyfin'});
  assert.equal(webhookRaceRetry.removedMs,0,'provider-operation recovery must not reapply a future full refund already reconciled by its webhook incident');
  assert.equal(webhookRaceRetry.alreadyAppliedByIncident,true,'recovery should identify the payment-incident reconciliation owner');
  const laterAfterRecovery = (await query('SELECT starts_at,current_period_end FROM subscriptions WHERE id=$1',[futureLater.id])).rows[0];
  assert.equal(new Date(laterAfterRecovery.starts_at).getTime(),new Date(laterAfterWebhook.starts_at).getTime(),'webhook-first recovery must not shift later prepaid starts twice');
  assert.equal(new Date(laterAfterRecovery.current_period_end).getTime(),new Date(laterAfterWebhook.current_period_end).getTime(),'webhook-first recovery must not shift later prepaid ends twice');

  // A separately funded extension must remain live after the base-only
  // pro-rata refund and be independently refundable without moving the queue twice.
  const extCustomer=(await query('INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *',[`Prorata extension ${suffix}`,`prorata-extension-${suffix}@example.invalid`])).rows[0];
  const extBase=(await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,provider_subscription_id,starts_at,current_period_end,service_type_snapshot,commercial_snapshot)
    VALUES($1,$2,'active','stripe','payment',$3,NOW()-INTERVAL '15 days',NOW()+INTERVAL '30 days','jellyfin',$4::jsonb) RETURNING *`,
    [extCustomer.id,plan.id,`pi_prorata_ext_base_${suffix}`,JSON.stringify({discountedMinor:5000,currency:'GBP',checkoutMode:'payment'})])).rows[0];
  const extRef=`pi_prorata_ext_bought_${suffix}`;
  await transaction(client=>extensions.applyPurchase(client,{customerId:extCustomer.id,subscriptionId:extBase.id,planId:plan.id,provider:'stripe',providerPaymentId:extRef,
    commercialSnapshot:{kind:'subscription_extension',extensionSubscriptionId:extBase.id,planId:plan.id,priceMinor:5000,discountedMinor:5000,currency:'GBP',billingInterval:'year',durationDays:365,streams:1,accessVariantKind:'streams',accessQuantity:1,provider:'stripe',checkoutMode:'payment'}}));
  const beforeExtension=(await query('SELECT current_period_end+make_interval(days=>service_extension_days) AS access_end FROM subscriptions WHERE id=$1',[extBase.id])).rows[0];
  const extQueue=(await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,provider_subscription_id,starts_at,current_period_end,service_type_snapshot,commercial_snapshot)
    VALUES($1,$2,'active','stripe','payment',$3,$4,$4::timestamptz+INTERVAL '30 days','jellyfin',$5::jsonb) RETURNING *`,
    [extCustomer.id,plan.id,`pi_prorata_ext_queue_${suffix}`,beforeExtension.access_end,JSON.stringify({discountedMinor:5000,currency:'GBP',checkoutMode:'payment'})])).rows[0];
  const extRequest={subscriptionId:extBase.id,customerId:extCustomer.id,originalEnd:extBase.current_period_end,cutoffAt:new Date(),serviceType:'jellyfin'};
  await refundLifecycle.applyPrepaidRefund(extRequest);
  const extAfter=(await query('SELECT *,current_period_end+make_interval(days=>service_extension_days) AS access_end FROM subscriptions WHERE id=$1',[extBase.id])).rows[0];
  const queueAfter=(await query('SELECT starts_at,current_period_end FROM subscriptions WHERE id=$1',[extQueue.id])).rows[0];
  assert.equal(extAfter.status,'expired');
  assert(Number(extAfter.service_extension_days)>=365,'base pro-rata refund must keep the separate yearly extension');
  const effective=await subscriptionState.effectiveSubscription(extCustomer.id,{includeBlocked:true});
  assert.equal(String(effective?.subscription_id||effective?.id),extBase.id,'the independently purchased access must remain usable');
  assert(Math.abs(+new Date(queueAfter.starts_at)-+new Date(extAfter.access_end))<1000,'queue must follow surviving extension, not the base refund cutoff');
  assert.equal((await refundLifecycle.applyPrepaidRefund(extRequest)).removedMs,0,'base refund replay must not shorten the extension');
  const queueReplay=(await query('SELECT starts_at FROM subscriptions WHERE id=$1',[extQueue.id])).rows[0];
  assert.equal(+new Date(queueReplay.starts_at),+new Date(queueAfter.starts_at));
  await extensions.revokeByProviderPayment({provider:'stripe',providerPaymentId:extRef,customerId:extCustomer.id,reason:'separate extension refund'});
  const afterExtensionLoss=(await query('SELECT service_extension_days FROM subscriptions WHERE id=$1',[extBase.id])).rows[0];
  assert.equal(Number(afterExtensionLoss.service_extension_days),0,'the extension is removed only by its own reversal');
  await query('DELETE FROM customers WHERE id=$1',[extCustomer.id]);

  const recurring = (await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,provider_subscription_id,starts_at,current_period_end,price_minor_snapshot,currency_snapshot,commercial_snapshot)
    VALUES($1,$2,'active','stripe',$3,NOW(),NOW()+INTERVAL '1 month',5000,'GBP',$4::jsonb) RETURNING id`, [customer.id,plan.id,`sub_prorata_${suffix}`,JSON.stringify({discountedMinor:5000,currency:'GBP',checkoutMode:'subscription'})])).rows[0];
  await assert.rejects(() => refunds.quote(recurring.id), /Recurring provider subscriptions/, 'recurring agreements must remain provider-authoritative and outside prepaid pro-rata refunds');

  const implementation = source('src/payments/prorata-refunds.js');
  const lifecycle = source('src/payments/lifecycle-prepaid-refunds.js');
  const providerRefunds = source('src/payments/provider-refund-adapters.js');
  assert(implementation.includes('FOR UPDATE OF s'), 'confirmation must recalculate under a subscription row lock');
  assert(implementation.includes('operation_type') && implementation.includes('prorata_refund'), 'provider/local refund divergence must have durable operation state');
  assert(lifecycle.includes("current_period_end=$2,status='expired'"), 'lifecycle owner must shorten the purchased entitlement');
  assert(lifecycle.includes('public.pull_prepaid_queue('), 'lifecycle owner must compact later prepaid periods through the shared overlap-safe queue owner');
  assert(lifecycle.includes('observedEndMs - cutoffMs'), 'lifecycle application must converge idempotently from the currently observed local end');
  assert(lifecycle.includes('alreadyAppliedByIncident'), 'lifecycle recovery must detect webhook-first full-refund reconciliation');
  assert(providerRefunds.includes('/v2/payments/captures/') && providerRefunds.includes('payment_intent:'), 'Stripe and PayPal one-time provider refunds must target exact stored payment references through the provider transport adapter');
  assert(implementation.includes('providerContract.refunds(request.provider).createOrObserve'), 'pro-rata refund policy must delegate provider mutation and observation to the canonical provider contract');
  assert(implementation.includes('provisioning.reconcileCustomer'), 'access must reconcile after local entitlement shortening');

  console.log('pro-rata refund DB smoke: ok — cash basis, prior refunds, recurring exclusion, lifecycle ownership, idempotent compaction and webhook-race recovery');
}

main().then(()=>getPool().end()).catch(async error => { console.error(error.stack || error); try { await getPool().end(); } catch (_) {} process.exit(1); });
