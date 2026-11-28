'use strict';
require('dotenv').config();
const assert=require('assert');
const {runDbSmoke,withRollback,fixtureCustomer,fixturePlan,unique}=require('./test-fixture');
const {previewFromEvidence,readEvidence}=require('./paid-value-preview');
runDbSmoke('paid value preview DB smoke',()=>withRollback(async client=>{
 const customer=await fixtureCustomer(client);
 const plan=await fixturePlan(client,{priceMinor:6000,serverClass:'premium'});
 const ref='pi_'+unique('value');
 const contract={kind:'direct_plan',checkoutMode:'payment',planId:plan.id,provider:'stripe',currency:'GBP',priceMinor:6000,discountedMinor:4500,serviceCreditMinor:0,billingInterval:'month',durationDays:30};
 const intent=(await client.query(`INSERT INTO billing_checkout_intents(scope,customer_id,plan_id,provider,checkout_mode,state,nonce_hash,expires_at,commercial_snapshot,provider_checkout_id)
 VALUES('customer',$1,$2,'stripe','payment','completed',$3,NOW()+INTERVAL '1 hour',$4::jsonb,$5) RETURNING id`,[customer.id,plan.id,unique('nonce'),JSON.stringify(contract),'cs_'+unique('value')])).rows[0];
 const row=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,provider_subscription_id,starts_at,current_period_end,currency_snapshot,commercial_snapshot,service_type_snapshot)
 VALUES($1,$2,'active','stripe','payment',$3,'2030-01-01T00:00:00Z','2030-02-01T00:00:00Z','GBP',$4::jsonb,'jellyfin') RETURNING id`,[customer.id,plan.id,ref,JSON.stringify({...contract,checkoutIntentId:intent.id})])).rows[0];
 const read=async()=>previewFromEvidence(await readEvidence(client,row.id));
 assert.strictEqual((await read()).reason,'payment_missing_or_ambiguous');
 const txn=unique('balance');
 await client.query(`INSERT INTO payment_history_transactions(provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,gross_amount_minor,fee_amount_minor,net_amount_minor,provider_reference_id,provider_source_id,customer_id,metadata)
 VALUES('stripe',$1,'charge','available',NOW(),'GBP',4500,150,4350,$2,$3,$4,$5::jsonb)`,[txn,ref,unique('charge'),customer.id,JSON.stringify({providerAuthoritative:true,liveStripeSync:true,checkoutIntentId:intent.id})]);
 const verified=await read();assert(verified.verified,JSON.stringify(verified));assert.strictEqual(verified.providerPaidMinor,'4500');
 await client.query(`INSERT INTO payment_incidents(provider,provider_event_id,provider_case_id,incident_type,incident_status,scope,customer_id,provider_subscription_id,amount_minor,currency,access_action,metadata)
 VALUES('stripe',$1,$2,'refund','recorded','direct',$3,$4,100,'GBP','preserve','{"fullRefund":false}'::jsonb)`,[unique('evt'),unique('refund'),customer.id,ref]);
 assert.strictEqual((await read()).reason,'adverse_or_open_change_requires_review');
})).catch(error=>{console.error(error.stack||error);process.exitCode=1;});
