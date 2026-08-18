'use strict';
require('dotenv').config();
const assert=require('assert');
const crypto=require('crypto');
const {getPool}=require('../src/db');
const state=require('../src/entitlements/subscription-state');
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
