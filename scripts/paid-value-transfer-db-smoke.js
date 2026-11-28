'use strict';
require('dotenv').config();
const assert=require('assert/strict');
const {runDbSmoke,withRollback,fixtureCustomer,fixturePlan,unique}=require('./test-fixture');
const {prepare,settlePrepared,verifySource,verifyTarget}=require('../src/payments/paid-value-transfer');
const {addPlanDuration}=require('../src/payments/billing-periods');
const carriedTime=require('../src/payments/carried-time');
const DAY=86400000;
runDbSmoke('prepared monetary transfer DB smoke',()=>withRollback(async client=>{
 const customer=await fixtureCustomer(client);
 const donorPlan=await fixturePlan(client,{priceMinor:6000,streams:1,serverClass:'premium'});
 const boughtPlan=await fixturePlan(client,{priceMinor:12000,currency:'USD',streams:2,serverClass:'premium'});
 const price=(await client.query('SELECT id FROM plan_prices WHERE plan_id=$1 AND currency=$2 AND active=TRUE',[boughtPlan.id,'USD'])).rows[0];
 assert(price,'plan fixture must have its default price');
 const ref='pi_'+unique('value'),sourceContract={kind:'direct_plan',checkoutMode:'payment',planId:donorPlan.id,provider:'stripe',currency:'GBP',priceMinor:6000,discountedMinor:4500,serviceCreditMinor:0,billingInterval:'month',durationDays:30};
 const sourceIntent=(await client.query(`INSERT INTO billing_checkout_intents(scope,customer_id,plan_id,provider,checkout_mode,state,nonce_hash,expires_at,commercial_snapshot,provider_checkout_id)
 VALUES('customer',$1,$2,'stripe','payment','completed',$3,NOW()+INTERVAL '1 hour',$4::jsonb,$5) RETURNING id`,[customer.id,donorPlan.id,unique('nonce'),JSON.stringify(sourceContract),'cs_'+unique('value')])).rows[0];
 const start=new Date(Date.now()-7*DAY),end=addPlanDuration(donorPlan,start);
 const source=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,provider_subscription_id,starts_at,current_period_end,currency_snapshot,commercial_snapshot,service_type_snapshot)
 VALUES($1,$2,'active','stripe','payment',$3,$4,$5,'GBP',$6::jsonb,'jellyfin') RETURNING *`,[customer.id,donorPlan.id,ref,start,end,JSON.stringify({...sourceContract,checkoutIntentId:sourceIntent.id})])).rows[0];
 await client.query(`INSERT INTO payment_history_transactions(provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,gross_amount_minor,fee_amount_minor,net_amount_minor,provider_reference_id,provider_source_id,customer_id,metadata)
 VALUES('stripe',$1,'charge','available',NOW(),'GBP',4500,150,4350,$2,$3,$4,$5::jsonb)`,[unique('txn'),ref,unique('charge'),customer.id,JSON.stringify({providerAuthoritative:true,liveStripeSync:true,checkoutIntentId:sourceIntent.id})]);
 const variant=(await client.query(`INSERT INTO plan_access_variants(plan_id,variant_kind,quantity,currency,price_minor) VALUES($1,'streams',4,'USD',18000) RETURNING id`,[boughtPlan.id])).rows[0];
 const mapping=(await client.query(`INSERT INTO plan_access_variant_provider_prices(access_variant_id,provider,checkout_mode,external_id) VALUES($1,'stripe','subscription',$2) RETURNING id,external_id`,[variant.id,'price_'+unique('variant')])).rows[0];
 const targetContract={kind:'direct_plan',checkoutMode:'subscription',planId:boughtPlan.id,planPriceId:price.id,provider:'stripe',currency:'USD',priceMinor:12000,discountedMinor:12000,billingInterval:'month',durationDays:30,streams:2,serverClass:'premium',providerMappingId:'price_'+unique('target')};
 // Identical access alone cannot silently copy GBP days into a USD plan.
 const checkSameAccess=()=>carriedTime.assertCarryPossible({customerId:customer.id,planId:donorPlan.id,snapshot:{currency:'USD',streams:1,serverClass:'premium'}},{db:(sql,params)=>client.query(sql,params)});
 await assert.rejects(checkSameAccess,{code:'CARRIED_TIME_VALUE_TRANSFER_REQUIRED'});
 let sourceChecks=0,targetChecks=0,rateChecks=0;
 const sourceVerifier=async(row,e)=>{sourceChecks++;assert.equal(row.id,source.id);assert.equal(e.providerPaidMinor,'4500');
   const payment={id:ref,status:'succeeded',amount_received:4500,currency:'gbp',metadata:{internal_checkout_intent_id:sourceIntent.id,internal_customer_id:customer.id,internal_plan_id:donorPlan.id},latest_charge:{paid:true,captured:true,disputed:false,amount_refunded:0,amount:4500,currency:'gbp'}};
   await verifySource(row,e,{stripeClient:async()=>({paymentIntents:{retrieve:async()=>payment}})});
   await assert.rejects(()=>verifySource(row,e,{stripeClient:async()=>({paymentIntents:{retrieve:async()=>({...payment,latest_charge:{...payment.latest_charge,amount_refunded:100}})}})}),/unreversed/);
 };
 const deps={sourceVerifier,rateFetcher:async(from,to)=>{rateChecks++;assert.equal(from,'GBP');assert.equal(to,'USD');const now=new Date();return {source:'frankfurter',base:from,quote:to,date:now.toISOString().slice(0,10),observedAt:now.toISOString(),rate:'1.25'};},targetVerifier:async(row,intent,prepared)=>{targetChecks++;assert.equal(row.plan_id,boughtPlan.id);
   const sub={id:row.provider_subscription_id,status:'active',metadata:{internal_checkout_intent_id:intent.id,internal_customer_id:row.customer_id,internal_plan_id:row.plan_id},items:{data:[{quantity:1,price:{id:prepared.providerMappingId,unit_amount:Number(prepared.target.normalPriceMinor),currency:'usd'},current_period_start:+new Date(row.starts_at)/1000,current_period_end:+new Date(row.current_period_end)/1000}]},latest_invoice:{status:'paid',billing_reason:'subscription_create',amount_paid:row.commercial_snapshot.discountedMinor,currency:'usd'}};
   const session={id:intent.provider_checkout_id,mode:'subscription',status:'complete',payment_status:'paid',subscription:sub.id,amount_total:row.commercial_snapshot.discountedMinor,currency:'usd'};
   const adapter=async()=>({subscriptions:{retrieve:async()=>sub},checkout:{sessions:{retrieve:async()=>session}}});
   await verifyTarget(row,intent,prepared,adapter);
   await assert.rejects(()=>verifyTarget(row,intent,prepared,async()=>({subscriptions:{retrieve:async()=>({...sub,latest_invoice:{...sub.latest_invoice,amount_paid:0}})},checkout:{sessions:{retrieve:async()=>session}}})),/not conclusively verified/);
 }};
 const variantContract={...targetContract,accessVariantId:variant.id,accessVariantKind:'streams',accessQuantity:4,streams:4,priceMinor:18000,discountedMinor:18000,providerMappingRecordId:mapping.id,providerMappingId:mapping.external_id};
 const variantPrepared=await prepare(client,{customerId:customer.id,planId:boughtPlan.id,snapshot:variantContract},deps);
 assert.equal(variantPrepared.preview.destinationCurrency,'USD');assert.equal(variantPrepared.preview.fx.numerator,'125');assert.equal(variantPrepared.target.normalPriceMinor,'18000');assert.equal(variantPrepared.target.accessVariantId,variant.id);
 await assert.rejects(()=>prepare(client,{customerId:customer.id,planId:boughtPlan.id,snapshot:{...variantContract,priceMinor:12000}},deps),/Normal destination price/);
 // The identical source now has a genuine applied earned-credit allocation.
 // Preparation must reject an unproven credit claim, then include both funding
 // components without increasing the original cash amount.
 const mixed={...sourceContract,serviceCreditMinor:1000,serviceCreditCurrency:'GBP',grossDiscountedMinor:5500};
 await client.query('UPDATE billing_checkout_intents SET commercial_snapshot=$2::jsonb WHERE id=$1',[sourceIntent.id,JSON.stringify(mixed)]);
 await client.query('UPDATE subscriptions SET commercial_snapshot=$2::jsonb WHERE id=$1',[source.id,JSON.stringify({...mixed,checkoutIntentId:sourceIntent.id})]);
 await assert.rejects(()=>prepare(client,{customerId:customer.id,planId:boughtPlan.id,snapshot:targetContract},deps),/funding allocations/);
 const grant=(await client.query(`INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,reference_id)
 VALUES($1,'GBP',1500,'earned','available',$2) RETURNING id`,[customer.id,unique('grant')])).rows[0];
 const reservation=(await client.query(`INSERT INTO affiliate_credit_checkout_reservations(customer_id,checkout_intent_id,currency,amount_minor,state,expires_at,applied_at)
 VALUES($1,$2,'GBP',1000,'applied',NOW()+INTERVAL '1 hour',NOW()) RETURNING id`,[customer.id,sourceIntent.id])).rows[0];
 const debit=(await client.query(`INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,reference_id,metadata)
 VALUES($1,'GBP',-1000,'redeemed','available',$2,$3::jsonb) RETURNING id`,[customer.id,'mixed-checkout:'+sourceIntent.id,JSON.stringify({checkoutIntentId:sourceIntent.id,reservationId:reservation.id})])).rows[0];
 await client.query(`INSERT INTO affiliate_credit_allocations(customer_id,currency,debit_ledger_id,grant_ledger_id,amount_minor)
 VALUES($1,'GBP',$2,$3,1000)`,[customer.id,debit.id,grant.id]);
 await client.query(`INSERT INTO affiliate_credit_recoveries(customer_id,currency,source_reward_id,amount_minor,reason)
 VALUES($1,'GBP',$2,100,'test reversal recovery')`,[customer.id,grant.id]);
 await assert.rejects(()=>prepare(client,{customerId:customer.id,planId:boughtPlan.id,snapshot:targetContract},deps),/funding allocations/);
 await client.query('DELETE FROM affiliate_credit_recoveries WHERE source_reward_id=$1',[grant.id]);
 sourceChecks=0;
 const prepared=await prepare(client,{customerId:customer.id,planId:boughtPlan.id,snapshot:targetContract},deps);
 assert.equal(prepared.preview.sourceProviderPaidMinor,'4500');
 assert.equal(prepared.preview.sourceServiceCreditPaidMinor,'1000');
 assert(prepared.preview.addedDays>0);assert.equal(sourceChecks,1);
 const receivingContract={...targetContract,discountedMinor:11000,grossDiscountedMinor:12000,serviceCreditMinor:1000,serviceCreditCurrency:'USD'};
 const intent=(await client.query(`INSERT INTO billing_checkout_intents(scope,customer_id,plan_id,plan_price_id,provider,checkout_mode,state,nonce_hash,expires_at,commercial_snapshot,provider_checkout_id,paid_value_transfer_snapshot)
 VALUES('customer',$1,$2,$3,'stripe','subscription','open',$4,NOW()+INTERVAL '1 hour',$5::jsonb,$6,$7::jsonb) RETURNING id`,[customer.id,boughtPlan.id,price.id,unique('nonce'),JSON.stringify(receivingContract),'cs_'+unique('target'),JSON.stringify(prepared)])).rows[0];
 const begin=new Date(Math.floor(Date.now()/1000)*1000),finish=addPlanDuration(boughtPlan,begin);
 const receiver=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,provider_subscription_id,starts_at,current_period_end,currency_snapshot,commercial_snapshot,service_type_snapshot)
 VALUES($1,$2,'active','stripe','subscription',$3,$4,$5,'USD',$6::jsonb,'jellyfin') RETURNING *`,[customer.id,boughtPlan.id,'sub_'+unique('target'),begin,finish,JSON.stringify({...receivingContract,checkoutIntentId:intent.id})])).rows[0];
 await assert.rejects(()=>settlePrepared(client,receiver,deps),/service-credit reservation/);
 assert.equal((await client.query('SELECT superseded_by FROM subscriptions WHERE id=$1',[source.id])).rows[0].superseded_by,null,'missing receiving credit cannot consume original value');
 const usdGrant=(await client.query(`INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,reference_id)
 VALUES($1,'USD',1200,'earned','available',$2) RETURNING id`,[customer.id,unique('usd-grant')])).rows[0];
 await client.query(`INSERT INTO affiliate_credit_checkout_reservations(customer_id,checkout_intent_id,currency,amount_minor,state,expires_at)
 VALUES($1,$2,'USD',1000,'reserved',NOW()+INTERVAL '1 hour')`,[customer.id,intent.id]);
 targetChecks=0;
 const outcome=await settlePrepared(client,receiver,deps);
 const receivingDebit=(await client.query("SELECT * FROM affiliate_credit_ledger WHERE entry_type='redeemed' AND reference_id=$1",['mixed-checkout:'+intent.id])).rows[0];
 assert.equal(receivingDebit.amount_minor,-1000);
 assert.equal((await client.query('SELECT amount_minor FROM affiliate_credit_allocations WHERE debit_ledger_id=$1 AND grant_ledger_id=$2',[receivingDebit.id,usdGrant.id])).rows[0].amount_minor,1000);
 const days=outcome.row.service_extension_days;assert(days>0);assert.equal(sourceChecks,2);assert.equal(targetChecks,1);
 assert.equal((await client.query('SELECT superseded_by FROM subscriptions WHERE id=$1',[source.id])).rows[0].superseded_by,receiver.id);
 const ledger=(await client.query('SELECT * FROM subscription_time_carryovers WHERE target_subscription_id=$1',[receiver.id])).rows[0];
 assert.equal(ledger.applied_days,days);assert.equal(ledger.reason,'monetary_plan_transfer');
 assert.equal(ledger.value_transfer_quote.sourceProviderPaidMinor,'4500');
 assert.equal(ledger.value_transfer_quote.sourceServiceCreditPaidMinor,'1000');
 assert.deepEqual(ledger.value_transfer_quote.receivingFunding,{cash:11000,credit:1000,gross:12000});
 const q=ledger.value_transfer_quote;
 assert.equal(BigInt(q.destinationRemainingCashValueMinor.numerator)+BigInt(q.destinationRemainingServiceCreditValueMinor.numerator),BigInt(q.destinationRemainingValueMinor.numerator));
 assert.equal(q.destinationRemainingCashValueMinor.denominator,q.destinationRemainingValueMinor.denominator);
 assert.equal(ledger.value_transfer_quote.sourceCurrency,'GBP');assert.equal(ledger.value_transfer_quote.destinationCurrency,'USD');assert.equal(rateChecks,3);
 assert.equal(Number((await client.query('SELECT public.rebalance_carried_time($1) AS delta',[receiver.id])).rows[0].delta),0,'exact rebalancing keeps initial quote');
 const replay=await settlePrepared(client,outcome.row,deps);
 assert.equal(replay.row.service_extension_days,days,'replay leaves original grant intact');
 assert.equal(targetChecks,1,'replay performs no second provider mutation or verification');
 assert.equal((await client.query("SELECT COUNT(*)::int AS n FROM affiliate_credit_ledger WHERE entry_type='redeemed' AND reference_id=$1",['mixed-checkout:'+intent.id])).rows[0].n,1,'replay must not debit destination credit twice');
 const removed=(await client.query('SELECT public.reverse_carried_paid_time($1,$2) AS removed',[source.id,'test_refund'])).rows[0].removed;
 assert.equal(Number(removed),days);
 assert.equal((await client.query('SELECT service_extension_days FROM subscriptions WHERE id=$1',[receiver.id])).rows[0].service_extension_days,0);
 assert.equal((await client.query('SELECT status FROM subscription_time_carryovers WHERE id=$1',[ledger.id])).rows[0].status,'reversed');
 const afterReversal=(await client.query('SELECT * FROM subscriptions WHERE id=$1',[receiver.id])).rows[0];
 assert.equal((await settlePrepared(client,afterReversal,deps)).row.service_extension_days,0,'replay cannot resurrect reversed value');
 assert.equal((await client.query('SELECT amount_minor FROM affiliate_credit_ledger WHERE id=$1',[debit.id])).rows[0].amount_minor,-1000,'transfer or source refund never issues new cash or credit');
})).catch(error=>{console.error(error.stack||error);process.exitCode=1;});
