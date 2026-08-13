'use strict';
const {query}=require('../db');
const positive=v=>{const n=Number(v);return Number.isInteger(n)&&n>0?n:null};
const text=(v,n=500)=>String(v||'').trim().slice(0,n);
async function options(mediaType){const r=await query(`SELECT id,code,name,description,sort_order,search_on_add,instance_name,instance_kind FROM media_quality_options WHERE active=TRUE AND route_enabled=TRUE AND instance_enabled=TRUE AND media_type=$1 ORDER BY sort_order,name`,[mediaType]);return r.rows}
async function tiers(){const r=await query(`SELECT DISTINCT id,code,name,description,active,sort_order FROM media_quality_options ORDER BY active DESC,sort_order,name`);return r.rows}
async function routes(){const r=await query('SELECT * FROM media_route_details ORDER BY tier_name,media_type');return r.rows}
async function route(tierId,mediaType){const r=await query(`SELECT * FROM media_route_details WHERE quality_tier_id=$1 AND media_type=$2 AND enabled=TRUE LIMIT 1`,[tierId,mediaType]);return r.rows[0]||null}
async function history(customerId){const r=await query(`SELECT mj.*,qt.name quality_name,qt.code quality_code,ai.name instance_name FROM media_jobs mj LEFT JOIN request_quality_tiers qt ON qt.id=mj.quality_tier_id LEFT JOIN arr_instances ai ON ai.id=mj.arr_instance_id WHERE mj.customer_id=$1 ORDER BY mj.created_at DESC LIMIT 250`,[customerId]);return r.rows}
async function queue(){const r=await query(`SELECT * FROM media_admin_queue ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 WHEN 'searching' THEN 2 WHEN 'added' THEN 3 ELSE 4 END,created_at DESC LIMIT 500`);return r.rows}
module.exports={positive,text,options,tiers,routes,route,history,queue};
