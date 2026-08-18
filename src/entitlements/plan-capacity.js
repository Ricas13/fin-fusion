'use strict';

const {query}=require('../db');

const LIVE_STATUSES=['active','trialing','past_due','paused'];
const LIVE_SQL=`superseded_by IS NULL AND status = ANY($2::text[]) AND starts_at<=NOW() AND current_period_end>NOW()`;
const RESERVATION_SQL=`consumed_at IS NULL AND released_at IS NULL AND expires_at>NOW()`;

async function usage(planId,db=query,{excludeReservationId=null}={}){
  const result=await db(`SELECT p.id,p.capacity_limit,
      (SELECT COUNT(DISTINCT s.customer_id)::int FROM subscriptions s WHERE s.plan_id=p.id AND ${LIVE_SQL}) AS used,
      (SELECT COUNT(*)::int FROM free_access_registration_reservations r WHERE r.plan_id=p.id AND ${RESERVATION_SQL} AND ($3::uuid IS NULL OR r.id<>$3::uuid)) AS reserved
    FROM plans p WHERE p.id=$1`,[planId,LIVE_STATUSES,excludeReservationId]);
  if(!result.rowCount)throw new Error('Plan not found.');
  const row=result.rows[0],limit=row.capacity_limit==null?null:Number(row.capacity_limit),used=Number(row.used||0),reserved=Number(row.reserved||0),occupied=used+reserved;
  return{planId:row.id,limit,used,reserved,remaining:limit==null?null:Math.max(0,limit-occupied),soldOut:limit!=null&&occupied>=limit};
}

async function assertAvailable(planId,{db=query,label='This plan',excludeReservationId=null}={}){
  const state=await usage(planId,db,{excludeReservationId});
  if(state.soldOut)throw new Error(`${label} is currently sold out.`);
  return state;
}

async function lockAndAssert(client,planId,label='This plan',{excludeReservationId=null}={}){
  // Transaction-scoped lock serializes free/trial acquisition and temporary
  // registration holds for a plan without affecting unrelated plans or renewals.
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('captainfin:plan-capacity:'||$1::text, 77133))`,[planId]);
  return assertAvailable(planId,{db:(sql,params)=>client.query(sql,params),label,excludeReservationId});
}

function acquisitionSql(alias='p'){
  return `(${alias}.capacity_limit IS NULL OR ${alias}.capacity_limit > ((
    SELECT COUNT(DISTINCT cs.customer_id) FROM subscriptions cs
    WHERE cs.plan_id=${alias}.id AND cs.superseded_by IS NULL
      AND cs.status IN ('active','trialing','past_due','paused')
      AND cs.starts_at<=NOW() AND cs.current_period_end>NOW()
  ) + (
    SELECT COUNT(*) FROM free_access_registration_reservations cr
    WHERE cr.plan_id=${alias}.id AND cr.consumed_at IS NULL AND cr.released_at IS NULL AND cr.expires_at>NOW()
  )))`;
}

module.exports={LIVE_STATUSES,usage,assertAvailable,lockAndAssert,acquisitionSql};
