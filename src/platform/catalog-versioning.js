'use strict';
const {query}=require('../db');
const planCommands=require('../catalog/plan-command-service');
async function cloneColumns(table,excluded){const r=await query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' AND identity_generation IS NULL ORDER BY ordinal_position`,[table]);return r.rows.map(x=>x.column_name).filter(c=>!excluded.has(c))}
async function clonePlan(sourceId,input,actorUserId=null){return planCommands.clonePlanVersion(sourceId,input,actorUserId)}
module.exports={clonePlan,cloneColumns};
