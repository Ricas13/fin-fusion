'use strict';
require('dotenv').config();
const assert=require('assert');
const crypto=require('crypto');
const {getPool}=require('../src/db');
const state=require('../src/entitlements/subscription-state');
const monthly=require('../src/resellers/monthly');
const managedUsers=require('../src/resellers/managed-users');
const accessHolds=require('../src/entitlements/access-holds');
const jobHealth=require('../src/automation/job-health');

async function main(){
 const client=await getPool().connect(),suffix=crypto.randomBytes(5).toString('hex');
 try{
  await client.query('BEGIN');
  const directPlan=(await client.query(`INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,active,visible,server_class,streams) VALUES($1,$2,'direct','month',30,699,'GBP',TRUE,TRUE,'premium',2) RETURNING *`,[`ci-direct-${suffix}`,`CI Direct ${suffix}`])).rows[0];
  const customer=(await client.query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`,[`CI Customer ${suffix}`,`ci-${suffix}@example.invalid`])).rows[0];
  const sub=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','admin_grant',NOW(),NOW()+INTERVAL '30 days') RETURNING *`,[customer.id,directPlan.id])).rows[0];
  assert.strictEqual(sub.plan_name_snapshot,directPlan.name,'subscription trigger must snapshot plan name');
  assert.strictEqual(Number(sub.price_minor_snapshot),699,'subscription trigger must snapshot contract price');
  await client.query(`UPDATE plans SET name='Changed catalogue name',price_minor=999,active=FALSE,visible=FALSE,archived_at=NOW() WHERE id=$1`,[directPlan.id]);
  const effective=await state.effectiveSubscription(customer.id,{client});
  assert(effective,'retiring a catalogue plan must not revoke a live contract');
  assert.strictEqual(effective.contract_plan_name,directPlan.name,'contract history must not follow later catalogue name edits');
  assert.strictEqual(Number(effective.contract_price_minor),699,'contract price must remain snapshotted');

  const futurePlan=(await client.query(`INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,active,visible,server_class,streams) VALUES($1,$2,'direct','month',30,600,'GBP',TRUE,TRUE,'premium',3) RETURNING *`,[`ci-future-${suffix}`,`CI Future ${suffix}`])).rows[0];
  await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','admin_grant',NOW()+INTERVAL '31 days',NOW()+INTERVAL '61 days')`,[customer.id,futurePlan.id]);
  const currentStillEffective=await state.effectiveSubscription(customer.id,{client,includeBlocked:true});
  assert.strictEqual(String(currentStillEffective.plan_id),String(directPlan.id),'future scheduled plan must not activate before starts_at');

  const resellerUser=(await client.query(`INSERT INTO app_users(email,username,password_hash,role,email_verified_at) VALUES($1,$2,'ci-hash','reseller',NOW()) RETURNING id`,[`res-${suffix}@example.invalid`,`res-${suffix}`])).rows[0];
  const reseller=(await client.query(`INSERT INTO resellers(user_id) VALUES($1) RETURNING *`,[resellerUser.id])).rows[0];
  const tier=(await client.query(`INSERT INTO reseller_tiers(code,name,description,monthly_price_minor,currency,seat_limit,capacity_limit,active,visible,streams,allow_video_transcoding,library_access_mode) VALUES($1,$2,'Managed seat lifecycle',5000,'GBP',1,10,TRUE,TRUE,2,FALSE,'all') RETURNING *`,[`ci-tier-${suffix}`,`CI Tier ${suffix}`])).rows[0];
  await client.query(`INSERT INTO reseller_subscriptions(reseller_id,tier_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','manual',NOW(),NOW()+INTERVAL '30 days')`,[reseller.id,tier.id]);
  const child=(await client.query(`INSERT INTO customers(reseller_id,display_name,reseller_managed) VALUES($1,$2,TRUE) RETURNING *`,[reseller.id,`Managed ${suffix}`])).rows[0];
  assert.strictEqual(await managedUsers.seatUsage(reseller.id,client),1,'managed Jellyfin user must consume one reseller seat');
  await accessHolds.addHold({customerId:child.id,type:'reseller_manual',sourceKey:reseller.id,reason:'CI temporary suspension'},client);
  assert.strictEqual(await managedUsers.seatUsage(reseller.id,client),1,'temporary suspension must not release the managed reseller seat');
  const entitlement=await monthly.resellerEntitlement(reseller.id,client);
  assert(entitlement.active&&Number(entitlement.row.seat_limit)===1,'parent reseller subscription must provide the managed-user allowance');
  let full=false;
  try{await managedUsers.assertSeatAvailable(client,reseller.id)}catch(error){full=/plan is full/i.test(error.message)}
  assert(full,'managed reseller seat limit must fail closed at capacity');
  const saleCount=await client.query(`SELECT COUNT(*)::int n FROM reseller_sales WHERE reseller_id=$1`,[reseller.id]);
  assert.strictEqual(Number(saleCount.rows[0].n),0,'managed reseller lifecycle must not write downstream sales');

  await client.query(`INSERT INTO automation_job_state(job_key,enabled,interval_seconds,next_run_at,force_run_requested) VALUES($1,FALSE,300,NOW()+INTERVAL '1 day',FALSE) ON CONFLICT(job_key) DO UPDATE SET enabled=FALSE,force_run_requested=FALSE,next_run_at=NOW()+INTERVAL '1 day'`,[`ci-force-${suffix}`]);
  const forced=await client.query(`UPDATE automation_job_state SET next_run_at=NOW(),force_run_requested=TRUE WHERE job_key=$1 RETURNING *`,[`ci-force-${suffix}`]);
  assert(forced.rows[0].force_run_requested,'disabled job must be able to carry a one-shot force request');
  assert.strictEqual(jobHealth.healthState(forced.rows[0]),'never_run','forced disabled never-run job must surface as never_run rather than disabled');
  console.log('lifecycle integrity database contract OK');
  await client.query('ROLLBACK');
 }catch(error){try{await client.query('ROLLBACK')}catch(_){}throw error}
 finally{client.release();await getPool().end()}
}
main().catch(error=>{console.error(error);process.exit(1)});
