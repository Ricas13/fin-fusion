'use strict';
require('dotenv').config();
const assert=require('assert/strict');
const {runDbSmoke,withRollback,fixtureCustomer,fixturePlan,unique}=require('./test-fixture');
const {prepare,settlePrepared,verifySource}=require('../src/payments/paid-value-transfer');
const {addPlanDuration}=require('../src/payments/billing-periods');
const DAY=86400000;
runDbSmoke('prepared monetary transfer DB smoke',()=>withRollback(async client=>{
 const customer=await fixtureCustomer(client);
 const donorPlan=await fixturePlan(client,{priceMinor:6000,streams:1,serverClass:'premium'});
 const boughtPlan=await fixturePlan(client,{priceMinor:12000,streams:2,serverClass:'premium'});
 const price=(await client.query('SELECT id FROM plan_prices WHERE plan_id=$1 AND currency=$2 AND active=TRUE',[boughtPlan.id,'GBP'])).rows[0];
 assert(price,'plan fixture must have its default price');
 const ref='pi_'+unique('value'),sourceContract={kind:'direct_plan',checkoutMode:'payment',planId:donorPlan.id,provider:'stripe',currency:'GBP',priceMinor:6000,discountedMinor:4500,serviceCreditMinor:0,billingInterval:'month',durationDays:30};
 const sourceIntent=(await client.query(`INSERT INTO billing_checkout_intents(scope,customer_id,plan_id,provider,checkout_mode,state,nonce_hash,expires_at,commercial_snapshot,provider_checkout_id)
 VALUES('customer',$1,$2,'stripe','payment','completed',$3,NOW()+INTERVAL '1 hour',$4::jsonb,$5) RETURNING id`,[customer.id,donorPlan.id,unique('nonce'),JSON.stringify(sourceContract),'cs_'+unique('value')])).rows[0];
 const start=new Date(Date.now()-7*DAY),end=addPlanDuration(donorPlan,start);
 const source=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,provider_subscription_id,starts_at,current_period_end,currency_snapshot,commercial_snapshot,service_type_snapshot)
 VALUES($1,$2,'active','stripe','payment',$3,$4,$5,'GBP',$6::jsonb,'jellyfin') RETURNING *`,[customer.id,donorPlan.id,ref,start,end,JSON.stringify({...sourceContract,checkoutIntentId:sourceIntent.id})])).rows[0];
 await client.query(`INSERT INTO payment_history_transactions(provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,gross_amount_minor,fee_amount_minor,net_amount_minor,provider_reference_id,provider_source_id,customer_id,metadata)
 VALUES('stripe',$1,'charge','available',NOW(),'GBP',4500,150,4350,$2,$3,$4,$5::jsonb)`,[unique('txn'),ref,unique('charge'),customer.id,JSON.stringify({providerAuthoritative:true,liveStripeSync:true,checkoutIntentId:sourceIntent.id})]);
 const targetContract={kind:'direct_plan',checkoutMode:'subscription',planId:boughtPlan.id,planPriceId:price.id,provider:'stripe',currency:'GBP',priceMinor:12000,discountedMinor:12000,billingInterval:'month',durationDays:30,streams:2,serverClass:'premium',providerMappingId:'price_'+unique('target')};
 let sourceChecks=0,targetChecks=0;
 const sourceVerifier=async(row,e)=>{sourceChecks++;assert.equal(row.id,source.id);assert.equal(e.providerPaidMinor,'4500');
   const payment={id:ref,status:'succeeded',amount_received:4500,currency:'gbp',metadata:{internal_checkout_intent_id:sourceIntent.id,internal_customer_id:customer.id,internal_plan_id:donorPlan.id},latest_charge:{paid:true,captured:true,disputed:false,amount_refunded:0,amount:4500,currency:'gbp'}};
   await verifySource(row,e,{stripeClient:async()=>({paymentIntents:{retrieve:async()=>payment}})});
   await assert.rejects(()=>verifySource(row,e,{stripeClient:async()=>({paymentIntents:{retrieve:async()=>({...payment,latest_charge:{...payment.latest_charge,amount_refunded:100}})}})}),/unreversed/);
 };
 const deps={sourceVerifier,targetVerifier:async(row)=>{targetChecks++;assert.equal(row.plan_id,boughtPlan.id);}};
 const prepared=await prepare(client,{customerId:customer.id,planId:boughtPlan.id,snapshot:targetContract},deps);
 assert(prepared.preview.addedDays>0);assert.equal(sourceChecks,1);
 const intent=(await client.query(`INSERT INTO billing_checkout_intents(scope,customer_id,plan_id,plan_price_id,provider,checkout_mode,state,nonce_hash,expires_at,commercial_snapshot,provider_checkout_id,paid_value_transfer_snapshot)
 VALUES('customer',$1,$2,$3,'stripe','subscription','open',$4,NOW()+INTERVAL '1 hour',$5::jsonb,$6,$7::jsonb) RETURNING id`,[customer.id,boughtPlan.id,price.id,unique('nonce'),JSON.stringify(targetContract),'cs_'+unique('target'),JSON.stringify(prepared)])).rows[0];
 const begin=new Date(Math.floor(Date.now()/1000)*1000),finish=addPlanDuration(boughtPlan,begin);
 const receiver=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,provider_subscription_id,starts_at,current_period_end,currency_snapshot,commercial_snapshot,service_type_snapshot)
 VALUES($1,$2,'active','stripe','subscription',$3,$4,$5,'GBP',$6::jsonb,'jellyfin') RETURNING *`,[customer.id,boughtPlan.id,'sub_'+unique('target'),begin,finish,JSON.stringify({...targetContract,checkoutIntentId:intent.id})])).rows[0];
 const outcome=await settlePrepared(client,receiver,deps);
 const days=outcome.row.service_extension_days;assert(days>0);assert.equal(sourceChecks,2);assert.equal(targetChecks,1);
 assert.equal((await client.query('SELECT superseded_by FROM subscriptions WHERE id=$1',[source.id])).rows[0].superseded_by,receiver.id);
 const ledger=(await client.query('SELECT * FROM subscription_time_carryovers WHERE target_subscription_id=$1',[receiver.id])).rows[0];
 assert.equal(ledger.applied_days,days);assert.equal(ledger.reason,'monetary_plan_transfer');
 assert.equal(ledger.value_transfer_quote.sourceProviderPaidMinor,'4500');
 assert.equal(Number((await client.query('SELECT public.rebalance_carried_time($1) AS delta',[receiver.id])).rows[0].delta),0,'exact rebalancing keeps initial quote');
 await assert.rejects(()=>settlePrepared(client,outcome.row,deps),/does not match/);
 const removed=(await client.query('SELECT public.reverse_carried_paid_time($1,$2) AS removed',[source.id,'test_refund'])).rows[0].removed;
 assert.equal(Number(removed),days);
 assert.equal((await client.query('SELECT service_extension_days FROM subscriptions WHERE id=$1',[receiver.id])).rows[0].service_extension_days,0);
 assert.equal((await client.query('SELECT status FROM subscription_time_carryovers WHERE id=$1',[ledger.id])).rows[0].status,'reversed');
})).catch(error=>{console.error(error.stack||error);process.exitCode=1;});
