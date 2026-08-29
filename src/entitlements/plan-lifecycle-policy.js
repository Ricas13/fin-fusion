'use strict';

const {query,transaction}=require('../db');

const DEFAULTS=Object.freeze({enabled:false,dryRun:true,noPlaybackDays:null,minimumPlaybackMinutes:null,playbackWindowDays:7,minimumObservationHours:24,deleteAfterDisableDays:null,action:'disable_jellyfin'});
function bool(value){return value===true||['true','1','on','yes'].includes(String(value||'').toLowerCase());}
function optionalInt(value,min,max){if(value===undefined||value===null||String(value).trim()==='')return null;const n=Number.parseInt(value,10);return Number.isInteger(n)&&n>=min&&n<=max?n:null;}
function int(value,min,max,fallback){const n=optionalInt(value,min,max);return n==null?fallback:n;}
function own(value,key){return Boolean(value)&&Object.prototype.hasOwnProperty.call(value,key);}
function normalize(value={}){return{enabled:bool(value.enabled),dryRun:value.dryRun===undefined?true:bool(value.dryRun),noPlaybackDays:optionalInt(value.noPlaybackDays,1,3650),minimumPlaybackMinutes:optionalInt(value.minimumPlaybackMinutes,1,1000000),playbackWindowDays:int(value.playbackWindowDays,1,365,DEFAULTS.playbackWindowDays),minimumObservationHours:int(value.minimumObservationHours,1,24*90,DEFAULTS.minimumObservationHours),deleteAfterDisableDays:optionalInt(value.deleteAfterDisableDays,1,3650),action:'disable_jellyfin'};}
function effectiveForFreePlan(value={},global={}){const local=normalize(value),inheritEnabled=!own(value,'enabled'),inheritDryRun=!own(value,'dryRun'),inheritNoPlayback=!own(value,'noPlaybackDays'),globalNoPlayback=optionalInt(global.freeNoPlaybackDays,1,3650);return{...local,enabled:bool(global.enabled)&&(inheritEnabled?true:local.enabled),dryRun:bool(global.dryRun)||(inheritDryRun?false:local.dryRun),noPlaybackDays:inheritNoPlayback?globalNoPlayback:local.noPlaybackDays,inherited:{enabled:inheritEnabled,dryRun:inheritDryRun,noPlaybackDays:inheritNoPlayback}};}
function hasUsageTrigger(value){return Boolean(value?.enabled&&(value.noPlaybackDays!=null||value.minimumPlaybackMinutes!=null));}
function noPlaybackBoundaryCrossedToday(assessment,policy,now=Date.now()){
 if(!assessment?.noPlaybackEligible||policy?.noPlaybackDays==null||!assessment?.referenceAt)return false;
 const reference=new Date(assessment.referenceAt),start=new Date(now);
 if(!Number.isFinite(reference.getTime())||!Number.isFinite(start.getTime()))return false;
 start.setUTCHours(0,0,0,0);
 return reference.getTime()>start.getTime()-Number(policy.noPlaybackDays)*86400000;
}
function usageTriggered(assessment,policy){const checks=[];if(policy?.noPlaybackDays!=null)checks.push(Boolean(assessment?.noPlaybackEligible)&&!noPlaybackBoundaryCrossedToday(assessment,policy));if(policy?.minimumPlaybackMinutes!=null)checks.push(Boolean(assessment?.usageEligible));return checks.length>0&&checks.every(Boolean);}
function validateForPlan(plan,input){
 const value=normalize(input),serviceType=String(plan?.service_type||'jellyfin');
 if(!['jellyfin','bundle'].includes(serviceType)){
   // Every plan row carries an inactivity_policy JSON value, but Stremio-only
   // products do not have a Jellyfin user whose lifecycle can be managed here.
   // Accept the inert/default policy emitted by shared creation forms while
   // rejecting any attempt to configure an actual Jellyfin lifecycle rule.
   const configured=value.enabled||value.noPlaybackDays!=null||value.minimumPlaybackMinutes!=null||value.deleteAfterDisableDays!=null;
   if(configured)throw new Error('Jellyfin lifecycle rules apply only to Jellyfin or bundle plans.');
   return{...DEFAULTS};
 }
 if(value.enabled&&(Number(plan?.price_minor||0)!==0||String(plan?.billing_interval||'')==='trial'))throw new Error('Usage-based inactivity disabling is limited to free non-trial Jellyfin/bundle plans. Paid and trial access is disabled when its entitlement lapses.');
 return value;
}
async function getPlan(planId){const r=await query('SELECT id,code,name,price_minor,billing_interval,service_type,inactivity_policy FROM plans WHERE id=$1',[planId]);return r.rows[0]||null;}
async function save(planId,input,actorUserId=null){const plan=await getPlan(planId);if(!plan)throw new Error('Plan not found.');const value=validateForPlan(plan,input);await transaction(async client=>{await client.query('UPDATE plans SET inactivity_policy=$2::jsonb,updated_at=NOW() WHERE id=$1',[planId,JSON.stringify(value)]);await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.plan.inactivity_policy.update','plan',$2,$3::jsonb)`,[actorUserId,planId,JSON.stringify({...value,portalAccountPreserved:true,lifecyclePolicyV2:true})]);});return value;}
module.exports={DEFAULTS,normalize,effectiveForFreePlan,hasUsageTrigger,noPlaybackBoundaryCrossedToday,usageTriggered,validateForPlan,getPlan,save};
