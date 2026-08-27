'use strict';

const scoped=require('./customer-inactivity-scoped');
const lifecyclePolicy=require('../entitlements/jellyfin-lifecycle-policy');

async function customerStatus(customerId){
  const globalCfg=await lifecyclePolicy.get();
  const worker=await scoped.activityWorkerTelemetry();
  let rows=await scoped.base.candidates(globalCfg,{customerId});
  let serverTelemetry={};
  if(rows.length&&worker.ready){
    serverTelemetry=await scoped.refreshCandidateServers(rows);
    // Re-read after the authoritative Jellyfin refresh so the portal evaluates
    // the same activity snapshot the enforcement worker would use.
    rows=await scoped.base.candidates(globalCfg,{customerId});
  }
  const telemetry=scoped.telemetrySummary(worker,serverTelemetry);
  const row=rows[0]||null;
  if(!row)return{applies:false,telemetry};
  const server=serverTelemetry[String(row.server_id)]||null;
  const enforcementReady=Boolean(worker.ready&&server?.ready);
  const reasons=Array.isArray(row.reasons)?[...row.reasons]:[];
  if(!worker.ready)reasons.push('Free Server usage enforcement is paused because playback telemetry is stale.');
  else if(!server?.ready)reasons.push('Free Server usage enforcement is paused because this server could not be refreshed safely.');
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
    policyEligible:Boolean(row.eligible),
    eligible:Boolean(row.eligible&&enforcementReady),
    enforcementReady,
    triggers:Array.isArray(row.triggers)?row.triggers:[],
    reasons,
    policy:row.policy||{}
  };
}

module.exports={customerStatus};