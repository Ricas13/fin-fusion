'use strict';

const scoped=require('./customer-inactivity-scoped');
const lifecyclePolicy=require('../entitlements/jellyfin-lifecycle-policy');

async function customerStatus(customerId){
  const globalCfg=await lifecyclePolicy.get();
  // Customer-facing health must remain visible even if automation is paused.
  // Candidate discovery needs an enabled policy to calculate the effective
  // 3/7/30 state, but actual removal eligibility below still respects the real
  // global enabled switch.
  const discoveryCfg=globalCfg.enabled?globalCfg:{...globalCfg,enabled:true};
  const worker=await scoped.activityWorkerTelemetry();
  let rows=await scoped.base.candidates(discoveryCfg,{customerId});
  let serverTelemetry={};
  if(rows.length&&worker.ready){
    serverTelemetry=await scoped.refreshCandidateServers(rows);
    serverTelemetry=await scoped.refreshCandidateUserActivity(rows,serverTelemetry);
    rows=await scoped.base.candidates(discoveryCfg,{customerId});
  }
  const telemetry=scoped.telemetrySummary(worker,serverTelemetry);
  const row=rows[0]||null;
  if(!row)return{applies:false,telemetry,globalEnforcementEnabled:Boolean(globalCfg.enabled)};
  const server=serverTelemetry[String(row.server_id)]||null;
  const telemetryReady=Boolean(worker.ready&&server?.ready);
  const enforcementReady=Boolean(globalCfg.enabled&&telemetryReady);
  const reasons=Array.isArray(row.reasons)?[...row.reasons]:[];
  if(!globalCfg.enabled)reasons.push('Free Server usage enforcement is paused by the administrator.');
  else if(!worker.ready)reasons.push('Free Server usage enforcement is paused because the activity worker heartbeat is stale.');
  else if(!server?.ready)reasons.push(`Free Server usage enforcement is paused because this server does not have a trustworthy recent playback sample${server?.reason?` (${server.reason})`:''}.`);
  return{
    applies:true,
    telemetry,
    planName:row.plan_name||row.plan_code||'Free Server',
    planCode:row.plan_code||null,
    allocationStartAt:row.allocation_start_at||null,
    firstPlaybackAt:row.first_playback_at||null,
    lastPlaybackAt:row.last_playback_at||null,
    inactiveReferenceAt:row.inactive_reference_at||null,
    observationStartedAt:row.observation_started_at||null,
    hasPlayback:Boolean(row.has_playback),
    playbackMinutes:Math.max(0,Math.round(Number(row.playback_seconds||0)/60)),
    currentlyPlaying:Boolean(row.currently_playing),
    automationProtected:Boolean(row.automation_protected),
    alreadyHeld:Boolean(row.already_held),
    policyEligible:Boolean(row.eligible),
    eligible:Boolean(row.eligible&&enforcementReady),
    enforcementReady,
    telemetryReady,
    globalEnforcementEnabled:Boolean(globalCfg.enabled),
    triggers:Array.isArray(row.triggers)?row.triggers:[],
    reasons,
    policy:row.policy||{}
  };
}

module.exports={customerStatus};