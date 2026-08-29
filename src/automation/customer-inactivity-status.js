'use strict';

const scoped=require('./customer-inactivity-scoped');
const lifecyclePolicy=require('../entitlements/jellyfin-lifecycle-policy');

async function customerStatus(customerId){
  const globalCfg=await lifecyclePolicy.get();
  const worker=await scoped.activityWorkerTelemetry();
  const rows=await scoped.base.candidates(globalCfg,{customerId});
  const serverTelemetry=rows.length&&worker.ready?await scoped.refreshCandidateServers(rows):{};
  const telemetry=scoped.telemetrySummary(worker,serverTelemetry);
  const row=rows[0]||null;
  if(!row)return{applies:false,telemetry};
  const server=serverTelemetry[String(row.server_id)]||null;
  const enforcementReady=Boolean(worker.ready&&server?.ready);
  const reasons=Array.isArray(row.reasons)?[...row.reasons]:[];
  if(!worker.ready)reasons.push('Free Server usage enforcement is paused because the activity worker heartbeat is stale.');
  else if(!server?.ready)reasons.push(`Free Server usage enforcement is paused because this server does not have a trustworthy recent playback sample${server?.reason?` (${server.reason})`:''}.`);
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