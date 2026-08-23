'use strict';

const inactivity=require('./customer-inactivity');

async function customerStatus(customerId){
  const [telemetry,rows]=await Promise.all([inactivity.telemetryReady(),inactivity.candidates()]);
  const row=rows.find(item=>String(item.customer_id)===String(customerId));
  if(!row)return{applies:false,telemetry};
  return{
    applies:true,
    telemetry,
    planName:row.plan_name||row.plan_code||'Free Server',
    planCode:row.plan_code||null,
    lastPlaybackAt:row.last_playback_at||null,
    inactiveReferenceAt:row.inactive_reference_at||null,
    playbackMinutes:Math.max(0,Math.round(Number(row.playback_seconds||0)/60)),
    currentlyPlaying:Boolean(row.currently_playing),
    automationProtected:Boolean(row.automation_protected),
    alreadyHeld:Boolean(row.already_held),
    eligible:Boolean(row.eligible),
    triggers:Array.isArray(row.triggers)?row.triggers:[],
    reasons:Array.isArray(row.reasons)?row.reasons:[],
    policy:row.policy||{}
  };
}

module.exports={customerStatus};
