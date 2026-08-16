'use strict';

const {query,transaction}=require('../db');

const DEFAULTS=Object.freeze({
  enabled:false,
  dryRun:true,
  noPlaybackDays:null,
  minimumPlaybackMinutes:null,
  playbackWindowDays:7,
  minimumObservationHours:24,
  action:'disable_jellyfin'
});

function bool(value){return value===true||['true','1','on','yes'].includes(String(value||'').toLowerCase());}
function optionalInt(value,min,max){
  if(value===undefined||value===null||String(value).trim()==='')return null;
  const n=Number.parseInt(value,10);
  return Number.isInteger(n)&&n>=min&&n<=max?n:null;
}
function int(value,min,max,fallback){const n=optionalInt(value,min,max);return n==null?fallback:n;}

function normalize(value={}){
  const noPlaybackDays=optionalInt(value.noPlaybackDays,1,3650);
  const minimumPlaybackMinutes=optionalInt(value.minimumPlaybackMinutes,1,1000000);
  return{
    enabled:bool(value.enabled),
    dryRun:value.dryRun===undefined?true:bool(value.dryRun),
    noPlaybackDays,
    minimumPlaybackMinutes,
    playbackWindowDays:int(value.playbackWindowDays,1,365,DEFAULTS.playbackWindowDays),
    minimumObservationHours:int(value.minimumObservationHours,1,24*90,DEFAULTS.minimumObservationHours),
    action:'disable_jellyfin'
  };
}

function validateForPlan(plan,input){
  const policy=normalize(input);
  if(!policy.enabled)return policy;
  const serviceType=String(plan?.service_type||'jellyfin');
  if(!['jellyfin','bundle'].includes(serviceType))throw new Error('Automatic inactivity rules apply only to Jellyfin or bundle plans.');
  if(Number(plan?.price_minor||0)!==0)throw new Error('Automatic plan inactivity disabling is limited to free Jellyfin/bundle plans. Paid and trial users remain governed only by the global Jellyfin cleanup rule.');
  if(policy.noPlaybackDays==null&&policy.minimumPlaybackMinutes==null)throw new Error('Enable at least one usage rule: no-playback days or minimum playback minutes.');
  return policy;
}

async function getPlan(planId){const r=await query('SELECT id,code,name,price_minor,service_type,inactivity_policy FROM plans WHERE id=$1',[planId]);return r.rows[0]||null;}
async function save(planId,input,actorUserId=null){
  const plan=await getPlan(planId);if(!plan)throw new Error('Plan not found.');
  const value=validateForPlan(plan,input);
  await transaction(async client=>{
    await client.query('UPDATE plans SET inactivity_policy=$2::jsonb,updated_at=NOW() WHERE id=$1',[planId,JSON.stringify(value)]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.plan.inactivity_policy.update','plan',$2,$3::jsonb)`,[actorUserId,planId,JSON.stringify(value)]);
  });
  return value;
}

module.exports={DEFAULTS,normalize,validateForPlan,getPlan,save};
