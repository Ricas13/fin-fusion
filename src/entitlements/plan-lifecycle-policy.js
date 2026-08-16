'use strict';

const {query,transaction}=require('../db');

const DEFAULTS=Object.freeze({
  enabled:false,
  dryRun:true,
  noPlaybackDays:null,
  minimumPlaybackMinutes:null,
  playbackWindowDays:7,
  minimumObservationHours:24,
  deleteAfterDisabledDays:null,
  action:'disable_jellyfin'
});

function bool(value){return value===true||['true','1','on','yes'].includes(String(value||'').toLowerCase());}
function optionalInt(value,min,max){if(value===undefined||value===null||String(value).trim()==='')return null;const n=Number.parseInt(value,10);return Number.isInteger(n)&&n>=min&&n<=max?n:null;}
function int(value,min,max,fallback){const n=optionalInt(value,min,max);return n==null?fallback:n;}
function normalize(value={}){return{
  enabled:bool(value.enabled),
  dryRun:value.dryRun===undefined?true:bool(value.dryRun),
  noPlaybackDays:optionalInt(value.noPlaybackDays,1,3650),
  minimumPlaybackMinutes:optionalInt(value.minimumPlaybackMinutes,1,1000000),
  playbackWindowDays:int(value.playbackWindowDays,1,365,DEFAULTS.playbackWindowDays),
  minimumObservationHours:int(value.minimumObservationHours,1,24*90,DEFAULTS.minimumObservationHours),
  deleteAfterDisabledDays:optionalInt(value.deleteAfterDisabledDays,1,3650),
  action:'disable_jellyfin'
};}
function validateForPlan(plan,input){
  const policy=normalize(input),serviceType=String(plan?.service_type||'jellyfin');
  if(!['jellyfin','bundle'].includes(serviceType))throw new Error('Jellyfin lifecycle overrides apply only to Jellyfin or bundle plans.');
  const freeUsage=Number(plan?.price_minor||0)===0&&String(plan?.billing_interval||'')!=='trial';
  if(policy.enabled&&!freeUsage)throw new Error('No-playback/minimum-usage disabling is only available on free non-trial Jellyfin/bundle plans. Paid and trial plans are disabled by their entitlement state.');
  if(policy.enabled&&policy.noPlaybackDays==null&&policy.minimumPlaybackMinutes==null)throw new Error('Enable at least one free-plan usage rule.');
  if(!freeUsage&&(policy.noPlaybackDays!=null||policy.minimumPlaybackMinutes!=null))throw new Error('Playback inactivity thresholds may only be set on free non-trial plans.');
  return policy;
}
async function getPlan(planId){const r=await query('SELECT id,code,name,price_minor,billing_interval,service_type,inactivity_policy FROM plans WHERE id=$1',[planId]);return r.rows[0]||null;}
async function save(planId,input,actorUserId=null){const plan=await getPlan(planId);if(!plan)throw new Error('Plan not found.');const value=validateForPlan(plan,input);await transaction(async client=>{await client.query('UPDATE plans SET inactivity_policy=$2::jsonb,updated_at=NOW() WHERE id=$1',[planId,JSON.stringify(value)]);await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.plan.jellyfin_lifecycle.update','plan',$2,$3::jsonb)`,[actorUserId,planId,JSON.stringify(value)]);});return value;}
module.exports={DEFAULTS,normalize,validateForPlan,getPlan,save};
