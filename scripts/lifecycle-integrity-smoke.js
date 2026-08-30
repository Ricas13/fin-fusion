'use strict';
require('dotenv').config();
const assert=require('assert');
const crypto=require('crypto');
const {getPool}=require('../src/db');
const state=require('../src/entitlements/subscription-state');
const jobHealth=require('../src/automation/job-health');
const lifecycle=require('../src/payments/lifecycle-primitives');

function assertIso(actual,expected,message){assert.strictEqual(actual.toISOString(),expected,message);}

async function main(){
 assertIso(lifecycle.addPlanDuration({billing_interval:'month',duration_days:30},new Date('2026-01-31T12:34:56.789Z')),'2026-02-28T12:34:56.789Z','monthly billing must clamp Jan 31 to February month-end');
 assertIso(lifecycle.addPlanDuration({billing_interval:'month',duration_days:30},new Date('2028-01-31T12:34:56.789Z')),'2028-02-29T12:34:56.789Z','monthly billing must honor leap-year February');
 assertIso(lifecycle.addPlanDuration({billingInterval:'month',durationDays:30},new Date('2026-08-31T08:15:00.000Z')),'2026-09-30T08:15:00.000Z','checkout snapshots must use calendar-month arithmetic');
 assertIso(lifecycle.addPlanDuration({billing_interval:'6_months',duration_days:180},new Date('2026-03-31T00:00:00.000Z')),'2026-09-30T00:00:00.000Z','six-month billing must use six calendar months');
 assertIso(lifecycle.addPlanDuration({billing_interval:'year',duration_days:365},new Date('2028-02-29T00:00:00.000Z')),'2029-02-28T00:00:00.000Z','yearly billing must clamp leap day to the following February');
 assertIso(lifecycle.addPlanDuration({billing_interval:'custom',duration_days:30},new Date('2026-02-01T00:00:00.000Z')),'2026-03-03T00:00:00.000Z','custom plans must keep exact day-duration arithmetic');

 const client=await getPool().connect(),suffix=crypto.randomBytes(5).toString('hex');
 try{
  await client.query('BEGIN');
  const directPlan=(await client.query(`INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,active,visible,server_class,streams,service_type) VALUES($1,$2,'direct','month',30,699,'GBP',TRUE,TRUE,'premium',2,'jellyfin') RETURNING *`,[`ci-direct-${suffix}`,`CI Direct ${suffix}`])).rows[0];
  const customer=(await client.query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`,[`CI Customer ${suffix}`,`ci-${suffix}@example.invalid`])).rows[0];
  const sub=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','admin_grant',NOW(),NOW()+INTERVAL '30 days') RETURNING *`,[customer.id,directPlan.id])).rows[0];
  assert.strictEqual(sub.plan_name_snapshot,directPlan.name,'subscription trigger must snapshot plan name');
  assert.strictEqual(Number(sub.price_minor_snapshot),699,'subscription trigger must snapshot contract price');
  await client.query(`UPDATE plans SET name='Changed catalogue name',price_minor=999,active=FALSE,visible=FALSE,archived_at=NOW() WHERE id=$1`,[directPlan.id]);
  const effective=await state.effectiveSubscription(customer.id,{client});
  assert(effective,'retiring a catalogue plan must not revoke a live contract');
  assert.strictEqual(effective.contract_plan_name,directPlan.name,'contract history must not follow later catalogue name edits');
  assert.strictEqual(Number(effective.contract_price_minor),699,'contract price must remain snapshotted');

  const stremioPlan=(await client.query(`INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,active,visible,server_class,streams,service_type) VALUES($1,$2,'direct','month',30,399,'GBP',TRUE,TRUE,'premium',1,'stremio') RETURNING *`,[`ci-stremio-${suffix}`,`CI Stremio ${suffix}`])).rows[0];
  await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','admin_grant',NOW(),NOW()+INTERVAL '90 days')`,[customer.id,stremioPlan.id]);
  const jellyfinWithStremio=await state.effectiveSubscription(customer.id,{client,includeBlocked:true});
  assert.strictEqual(String(jellyfinWithStremio.plan_id),String(directPlan.id),'a later-ending Stremio-only subscription must never replace the current Jellyfin entitlement');

  const futurePlan=(await client.query(`INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,active,visible,server_class,streams,service_type) VALUES($1,$2,'direct','month',30,600,'GBP',TRUE,TRUE,'premium',3,'jellyfin') RETURNING *`,[`ci-future-${suffix}`,`CI Future ${suffix}`])).rows[0];
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