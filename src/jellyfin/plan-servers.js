'use strict';

const { query } = require('../db');
const serviceCatalog=require('../catalog/service-catalog');
function planId(plan){return plan?.plan_id||plan?.id||null}
function mediaTypeForPlan(plan){const type=serviceCatalog.serviceType(plan);return type==='bundle'?'jellyfin':serviceCatalog.mediaServerType(plan);}
async function placementHealthMode(){const r=await query(`SELECT setting_value FROM platform_settings WHERE setting_key='operations_v1'`),mode=String(r.rows[0]?.setting_value?.placementHealthMode||'healthy_or_degraded');return['healthy_only','healthy_or_degraded','fail_open'].includes(mode)?mode:'healthy_or_degraded'}
function healthEligible(server,mode){const status=String(server?.health_status||'unknown');if(mode==='healthy_only')return status==='healthy';if(mode==='fail_open')return status!=='offline';return ['healthy','degraded'].includes(status)}
async function eligibleServersForPlan(plan,{enabledOnly=true,forPlacement=true}={}){
 const mediaType=mediaTypeForPlan(plan);
 if(!plan?.server_class||!mediaType)return[];
 const id=planId(plan),mode=await placementHealthMode();
 if(!id){const result=await query(`SELECT * FROM jellyfin_servers WHERE server_class=$1 AND COALESCE(media_server_type,'jellyfin')=$2 ${enabledOnly?'AND enabled=TRUE':''} ${forPlacement?"AND COALESCE(placement_mode,'active')='active'":''} ORDER BY priority,name`,[plan.server_class,mediaType]);return forPlacement?result.rows.filter(server=>healthEligible(server,mode)):result.rows}
 const result=await query(`WITH restriction AS (
   SELECT EXISTS(
     SELECT 1 FROM plan_server_eligibility pse
     JOIN jellyfin_servers restricted_server ON restricted_server.id=pse.server_id
     WHERE pse.plan_id=$2 AND restricted_server.server_class=$1 AND COALESCE(restricted_server.media_server_type,'jellyfin')=$3
   ) AS restricted
 )
 SELECT js.*,pse.weight AS placement_weight
 FROM jellyfin_servers js
 CROSS JOIN restriction r
 LEFT JOIN plan_server_eligibility pse ON pse.plan_id=$2 AND pse.server_id=js.id
 WHERE js.server_class=$1 AND COALESCE(js.media_server_type,'jellyfin')=$3
 ${enabledOnly?'AND js.enabled=TRUE':''}
 ${forPlacement?"AND COALESCE(js.placement_mode,'active')='active'":''}
 AND (NOT r.restricted OR pse.server_id IS NOT NULL)
 ORDER BY js.priority,js.name`,[plan.server_class,id,mediaType]);
 return forPlacement?result.rows.filter(server=>healthEligible(server,mode)):result.rows
}
module.exports={planId,mediaTypeForPlan,eligibleServersForPlan,placementHealthMode,healthEligible};
