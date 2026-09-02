'use strict';
require('dotenv').config();
const crypto=require('crypto');
const {getPool}=require('../src/db');
const subscriptionState=require('../src/entitlements/subscription-state');
function assert(value,message){if(!value)throw new Error(message)}
async function expectConstraint(client,sql,params,label){await client.query('SAVEPOINT expected_failure');try{await client.query(sql,params);throw new Error(`${label}: expected database rejection`)}catch(error){await client.query('ROLLBACK TO SAVEPOINT expected_failure');if(String(error.message).includes('expected database rejection'))throw error}finally{await client.query('RELEASE SAVEPOINT expected_failure').catch(()=>{})}}
async function main(){
 const client=await getPool().connect();
 try{
  await client.query('BEGIN');
  const suffix=crypto.randomBytes(5).toString('hex');
  const canonicalFree=await client.query(`SELECT id,active,visible,price_minor,capacity_limit FROM plans WHERE is_free_tier=TRUE`);
  assert(canonicalFree.rowCount===1,'platform must have exactly one canonical free tier');
  assert(canonicalFree.rows[0].active&&canonicalFree.rows[0].visible&&Number(canonicalFree.rows[0].price_minor)===0,'canonical free tier must stay active, visible and zero-priced');

  const user=(await client.query(`INSERT INTO app_users(username,email,password_hash,role,active,email_verified_at) VALUES($1,$2,'not-a-real-login-hash','customer',TRUE,NOW()) RETURNING id`,[`coherence-${suffix}`,`coherence-${suffix}@example.invalid`])).rows[0];
  const customer=(await client.query(`INSERT INTO customers(user_id,display_name,email) VALUES($1,$2,$3) RETURNING id`,[user.id,`Coherence ${suffix}`,`coherence-${suffix}@example.invalid`])).rows[0];
  const plan=(await client.query(`INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible) VALUES($1,'Coherence Direct','direct','month',30,0,'GBP',1,'custom',TRUE,TRUE) RETURNING id`,[`coherence-direct-${suffix}`])).rows[0];
  const free=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','free_claim',NOW(),NOW()+INTERVAL '30 days') RETURNING id`,[customer.id,plan.id])).rows[0];
  assert(free.id,'free_claim must be accepted by the source constraint');
  await client.query(`UPDATE subscriptions SET status='expired' WHERE id=$1`,[free.id]);

  const future=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','free_claim',NOW()+INTERVAL '1 day',NOW()+INTERVAL '31 days') RETURNING id`,[customer.id,plan.id])).rows[0];
  const premature=await subscriptionState.effectiveSubscription(customer.id,{client,includeBlocked:true});
  assert(!premature,'a future-dated subscription must not become effective before starts_at');
  await client.query(`UPDATE subscriptions SET status='expired' WHERE id=$1`,[future.id]);

  // Current Stremio delivery does not require an entitlement-level Jellyfin
  // server/account/token tuple. The database trigger must allow an activated
  // install credential with those retired delivery columns detached.
  const stremioPlan=(await client.query(`INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible,service_type) VALUES($1,'Coherence Stremio','direct','month',30,0,'GBP',1,'custom',TRUE,TRUE,'stremio') RETURNING id`,[`coherence-stremio-${suffix}`])).rows[0];
  const stremioSub=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','free_claim',NOW(),NOW()+INTERVAL '30 days') RETURNING id`,[customer.id,stremioPlan.id])).rows[0];
  const installHash=crypto.createHash('sha256').update(`coherence-stremio-${suffix}`).digest('hex');
  const detached=(await client.query(`INSERT INTO stremio_entitlements(customer_id,subscription_id,status,stream_limit,token_hash) VALUES($1,$2,'active',1,$3) RETURNING id,server_id,jellyfin_account_id,jellyfin_access_token_encrypted`,[customer.id,stremioSub.id,installHash])).rows[0];
  assert(detached.id,'detached source-based Stremio entitlement must be accepted');
  assert(detached.server_id===null&&detached.jellyfin_account_id===null&&detached.jellyfin_access_token_encrypted===null,'source-based Stremio entitlement must remain detached from the retired Jellyfin delivery identity');
  await client.query(`UPDATE subscriptions SET status='expired' WHERE id=$1`,[stremioSub.id]);

  await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id) VALUES($1,$2,'active','stripe','subscription',NOW(),NOW()+INTERVAL '30 days',$3)`,[customer.id,plan.id,`sub_${suffix}_one`]);
  await expectConstraint(client,`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id) VALUES($1,$2,'active','paypal','subscription',NOW(),NOW()+INTERVAL '30 days',$3)`,[customer.id,plan.id,`I-${suffix}-two`],'overlapping recurring customer subscription');

  // Provider-customer identity semantics: PayPal payer IDs are funding-account
  // identities and may legitimately fan in to multiple CAPTAiNFiN customers.
  // Stripe customer objects are CAPTAiNFiN-created and remain one-to-one.
  const payerA=(await client.query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`,[`PayPal A ${suffix}`,`paypal-a-${suffix}@example.invalid`])).rows[0];
  const payerB=(await client.query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`,[`PayPal B ${suffix}`,`paypal-b-${suffix}@example.invalid`])).rows[0];
  const sharedPayer=`PAYER-${suffix}`;
  await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_customer_id,provider_subscription_id) VALUES($1,$2,'active','paypal','subscription',NOW(),NOW()+INTERVAL '30 days',$3,$4)`,[payerA.id,plan.id,sharedPayer,`I-${suffix}-A`]);
  await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_customer_id,provider_subscription_id) VALUES($1,$2,'active','paypal','subscription',NOW(),NOW()+INTERVAL '30 days',$3,$4)`,[payerB.id,plan.id,sharedPayer,`I-${suffix}-B`]);
  const sharedPayPalRows=await client.query(`SELECT customer_id FROM payment_customers WHERE provider='paypal' AND provider_customer_id=$1 ORDER BY customer_id`,[sharedPayer]);
  assert(sharedPayPalRows.rowCount===2,'one PayPal payer must be allowed to fund two distinct CAPTAiNFiN customers');

  const stripeA=(await client.query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`,[`Stripe A ${suffix}`,`stripe-a-${suffix}@example.invalid`])).rows[0];
  const stripeB=(await client.query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`,[`Stripe B ${suffix}`,`stripe-b-${suffix}@example.invalid`])).rows[0];
  const sharedStripe=`cus_${suffix}`;
  await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_customer_id,provider_subscription_id) VALUES($1,$2,'active','stripe','subscription',NOW(),NOW()+INTERVAL '30 days',$3,$4)`,[stripeA.id,plan.id,sharedStripe,`sub_${suffix}_A`]);
  await expectConstraint(client,`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_customer_id,provider_subscription_id) VALUES($1,$2,'active','stripe','subscription',NOW(),NOW()+INTERVAL '30 days',$3,$4)`,[stripeB.id,plan.id,sharedStripe,`sub_${suffix}_B`],'shared Stripe customer identity');
  const rolledBackStripe=await client.query(`SELECT 1 FROM subscriptions WHERE customer_id=$1 AND source='stripe' AND provider_subscription_id=$2`,[stripeB.id,`sub_${suffix}_B`]);
  assert(rolledBackStripe.rowCount===0,'Stripe identity collision must roll back the subscription instead of leaving a half-linked purchase');
  const stripeMappings=await client.query(`SELECT customer_id FROM payment_customers WHERE provider='stripe' AND provider_customer_id=$1`,[sharedStripe]);
  assert(stripeMappings.rowCount===1&&String(stripeMappings.rows[0].customer_id)===String(stripeA.id),'Stripe customer identity must remain owned by exactly one CAPTAiNFiN customer');

  const plisioCustomer=(await client.query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`,[`Plisio ${suffix}`,`plisio-${suffix}@example.invalid`])).rows[0];
  const plisioIdentity=(await client.query(`INSERT INTO payment_customers(customer_id,provider,provider_customer_id) VALUES($1,'plisio',$2) RETURNING id`,[plisioCustomer.id,`plisio-${suffix}`])).rows[0];
  assert(plisioIdentity.id,'payment_customers provider constraint must include supported Plisio records');

  await client.query(`INSERT INTO customer_access_holds(customer_id,hold_type,source_key,reason) VALUES($1,'admin_suspended','admin','admin test'),($1,'payment_risk','risk-test','risk test')`,[customer.id]);
  const holds=await client.query(`SELECT COUNT(*)::int n FROM customer_access_holds WHERE customer_id=$1 AND released_at IS NULL`,[customer.id]);
  assert(Number(holds.rows[0].n)===2,'independent access holds must coexist');
  await client.query(`UPDATE customer_access_holds SET released_at=NOW() WHERE customer_id=$1 AND hold_type='admin_suspended'`,[customer.id]);
  const remaining=await client.query(`SELECT hold_type FROM customer_access_holds WHERE customer_id=$1 AND released_at IS NULL`,[customer.id]);
  assert(remaining.rowCount===1&&remaining.rows[0].hold_type==='payment_risk','releasing one hold must preserve other hold types');

  const supportedSeeded=await client.query(`SELECT COUNT(*)::int n FROM automation_job_state`);
  assert(Number(supportedSeeded.rows[0].n)>=9,'supported platform automation seed rows were unexpectedly removed');

  const brandingColumns=await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name='branding_assets'`);
  assert(brandingColumns.rows.some(row=>row.column_name==='content'),'shared branding storage must include binary content');
  const driftColumns=await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name='jellyfin_policy_drift'`);
  assert(driftColumns.rowCount>0,'policy drift state table must exist');

  await client.query('ROLLBACK');
  console.log('Platform coherence DB invariants OK.');
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}
 finally{client.release();await getPool().end()}
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1});
