'use strict';

const {query}=require('../db');

async function forEntitlement(entitlement){
  if(!entitlement?.subscription_id)return[];
  const result=await query(`SELECT s.*,ps.priority plan_priority
    FROM subscriptions sub
    JOIN plan_stremio_sources ps ON ps.plan_id=sub.plan_id AND ps.enabled=TRUE
    JOIN stremio_sources s ON s.id=ps.source_id
    JOIN stremio_source_index_state i ON i.source_id=s.id
    WHERE sub.id=$1
      AND s.enabled=TRUE
      AND s.auth_state='connected'
      AND i.status='ready'
      AND i.item_count>0
    ORDER BY ps.priority,s.priority,s.name`,[entitlement.subscription_id]);
  return result.rows;
}

async function authorized(entitlement,sourceId){
  const rows=await forEntitlement(entitlement);
  return rows.find(source=>String(source.id)===String(sourceId))||null;
}

async function stateForPlan(planId){
  if(!planId)return{selected:0,ready:0};
  const result=await query(`SELECT
      COUNT(*) FILTER(WHERE ps.enabled=TRUE)::int selected,
      COUNT(*) FILTER(WHERE ps.enabled=TRUE AND s.enabled=TRUE AND s.auth_state='connected' AND i.status='ready' AND i.item_count>0)::int ready
    FROM plan_stremio_sources ps
    LEFT JOIN stremio_sources s ON s.id=ps.source_id
    LEFT JOIN stremio_source_index_state i ON i.source_id=s.id
    WHERE ps.plan_id=$1`,[planId]);
  return{
    selected:Number(result.rows[0]?.selected||0),
    ready:Number(result.rows[0]?.ready||0)
  };
}

async function statesForAllPlans(){
  const result=await query(`SELECT
      p.id plan_id,
      COUNT(ps.source_id) FILTER(WHERE ps.enabled=TRUE)::int selected,
      COUNT(ps.source_id) FILTER(WHERE ps.enabled=TRUE AND s.enabled=TRUE AND s.auth_state='connected' AND i.status='ready' AND i.item_count>0)::int ready
    FROM plans p
    LEFT JOIN plan_stremio_sources ps ON ps.plan_id=p.id
    LEFT JOIN stremio_sources s ON s.id=ps.source_id
    LEFT JOIN stremio_source_index_state i ON i.source_id=s.id
    WHERE p.service_type IN('stremio','bundle')
    GROUP BY p.id`);
  return Object.fromEntries(result.rows.map(row=>[String(row.plan_id),{
    selected:Number(row.selected||0),
    ready:Number(row.ready||0)
  }]));
}

module.exports={forEntitlement,authorized,stateForPlan,statesForAllPlans};
