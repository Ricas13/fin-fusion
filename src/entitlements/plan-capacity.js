'use strict';

const {query}=require('../db');

const LIVE_STATUSES=['active','trialing','past_due','paused'];
const LIVE_SQL=`superseded_by IS NULL AND status = ANY($2::text[]) AND starts_at<=NOW() AND current_period_end>NOW()`;

async function usage(planId,db=query){
  const result=await db(`SELECT p.id,p.capacity_limit,
      (SELECT COUNT(DISTINCT s.customer_id)::int FROM subscriptions s WHERE s.plan_id=p.id AND ${LIVE_SQL}) AS used
    FROM plans p WHERE p.id=$1`,[planId,LIVE_STATUSES]);
  if(!result.rowCount)throw new Error('Plan not found.');
  const row=result.rows[0],limit=row.capacity_limit==null?null:Number(row.capacity_limit),used=Number(row.used||0);
  return{planId:row.id,limit,used,remaining:limit==null?null:Math.max(0,limit-used),soldOut:limit!=null&&used>=limit};
}

async function assertAvailable(planId,{db=query,label='This plan'}={}){
  const state=await usage(planId,db);
  if(state.soldOut)throw new Error(`${label} is currently sold out.`);
  return state;
}

async function lockAndAssert(client,planId,label='This plan'){
  // Transaction-scoped lock serializes free/trial acquisition for a plan without
  // affecting unrelated plans or renewals.
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('captainfin:plan-capacity:'||$1::text, 77133))`,[planId]);
  return assertAvailable(planId,{db:(sql,params)=>client.query(sql,params),label});
}

function acquisitionSql(alias='p'){
  return `(${alias}.capacity_limit IS NULL OR ${alias}.capacity_limit > (
    SELECT COUNT(DISTINCT cs.customer_id) FROM subscriptions cs
    WHERE cs.plan_id=${alias}.id AND cs.superseded_by IS NULL
      AND cs.status IN ('active','trialing','past_due','paused')
      AND cs.starts_at<=NOW() AND cs.current_period_end>NOW()
  ))`;
}

module.exports={LIVE_STATUSES,usage,assertAvailable,lockAndAssert,acquisitionSql};
