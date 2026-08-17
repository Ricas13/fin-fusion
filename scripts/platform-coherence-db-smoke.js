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

  await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,provider_subscription_id) VALUES($1,$2,'active','stripe',NOW(),NOW()+INTERVAL '30 days',$3)`,[customer.id,plan.id,`sub_${suffix}_one`]);
  await expectConstraint(client,`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,provider_subscription_id) VALUES($1,$2,'active','paypal',NOW(),NOW()+INTERVAL '30 days',$3)`,[customer.id,plan.id,`I-${suffix}-two`],'overlapping recurring customer subscription');

  await client.query(`INSERT INTO customer_access_holds(customer_id,hold_type,source_key,reason) VALUES($1,'admin_suspended','admin','admin test'),($1,'reseller_manual','reseller-test','reseller test')`,[customer.id]);
  const holds=await client.query(`SELECT COUNT(*)::int n FROM customer_access_holds WHERE customer_id=$1 AND released_at IS NULL`,[customer.id]);
  assert(Number(holds.rows[0].n)===2,'independent historical access holds must coexist');
  await client.query(`UPDATE customer_access_holds SET released_at=NOW() WHERE customer_id=$1 AND hold_type='admin_suspended'`,[customer.id]);
  const remaining=await client.query(`SELECT hold_type FROM customer_access_holds WHERE customer_id=$1 AND released_at IS NULL`,[customer.id]);
  assert(remaining.rowCount===1&&remaining.rows[0].hold_type==='reseller_manual','releasing one hold must preserve historical hold types');

  // Historical reseller schema remains upgrade-safe even though the reseller
  // product and automation runtime are no longer exposed or executed.
  const resellerUser=(await client.query(`INSERT INTO app_users(username,email,password_hash,role,active,email_verified_at) VALUES($1,$2,'not-a-real-login-hash','reseller',TRUE,NOW()) RETURNING id`,[`coherence-reseller-${suffix}`,`reseller-${suffix}@example.invalid`])).rows[0];
  const reseller=(await client.query(`INSERT INTO resellers(user_id) VALUES($1) RETURNING id`,[resellerUser.id])).rows[0];
  const tier=(await client.query(`INSERT INTO reseller_tiers(code,name,description,monthly_price_minor,currency,seat_limit,grace_days,sort_order,visible,active,streams,allow_video_transcoding,library_access_mode) VALUES($1,'Coherence Tier','test',1234,'GBP',7,3,100,TRUE,TRUE,5,FALSE,'include') RETURNING id`,[`coherence-tier-${suffix}`])).rows[0];
  const resellerSub=(await client.query(`INSERT INTO reseller_subscriptions(reseller_id,tier_id,status,source,starts_at,current_period_end,provider_subscription_id) VALUES($1,$2,'active','stripe',NOW(),NOW()+INTERVAL '30 days',$3) RETURNING *`,[reseller.id,tier.id,`sub_reseller_${suffix}`])).rows[0];
  assert(Number(resellerSub.monthly_price_minor_snapshot)===1234,'historical reseller subscription must preserve snapshotted price');
  assert(Number(resellerSub.seat_limit_snapshot)===7,'historical reseller subscription must preserve snapshotted seat limit');
  assert(String(resellerSub.currency_snapshot).trim()==='GBP','historical reseller subscription must preserve currency');
  assert(Number(resellerSub.grace_days_snapshot)===3,'historical reseller subscription must preserve grace days');
  await expectConstraint(client,`INSERT INTO reseller_subscriptions(reseller_id,tier_id,status,source,starts_at,current_period_end,provider_subscription_id) VALUES($1,$2,'active','paypal',NOW(),NOW()+INTERVAL '30 days',$3)`,[reseller.id,tier.id,`I-RESELLER-${suffix}`],'overlapping historical reseller subscription');

  const managed=(await client.query(`INSERT INTO customers(reseller_id,display_name,reseller_managed) VALUES($1,$2,TRUE) RETURNING id`,[reseller.id,`Managed ${suffix}`])).rows[0];
  assert(managed.id,'historical reseller managed-user identities must remain readable after upgrade');
  const saleCount=await client.query(`SELECT COUNT(*)::int n FROM reseller_sales WHERE reseller_id=$1`,[reseller.id]);
  assert(Number(saleCount.rows[0].n)===0,'historical managed seat setup must not fabricate downstream sales');

  const retiredJobs=['reseller_billing','reseller_estates','reseller_notifications'];
  const retiredRows=await client.query(`SELECT job_key FROM automation_job_state WHERE job_key=ANY($1::text[])`,[retiredJobs]);
  assert(retiredRows.rowCount===0,`retired reseller automation scheduler rows remain: ${retiredRows.rows.map(r=>r.job_key).join(', ')}`);
  const supportedSeeded=await client.query(`SELECT COUNT(*)::int n FROM automation_job_state`);
  assert(Number(supportedSeeded.rows[0].n)>=9,'supported platform automation seed rows were unexpectedly removed');

  const brandingColumns=await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name='branding_assets'`);
  assert(brandingColumns.rows.some(row=>row.column_name==='content'),'shared branding storage must include binary content');
  const driftColumns=await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name='jellyfin_policy_drift'`);
  assert(driftColumns.rowCount>0,'policy drift state table must exist');

  await client.query('ROLLBACK');
  console.log('Platform coherence DB invariants OK: current runtime clean, historical reseller schema preserved.');
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}
 finally{client.release();await getPool().end()}
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1});