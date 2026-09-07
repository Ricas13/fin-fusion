'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const policy=require('../src/entitlements/plan-lifecycle-policy');
const inactivity=require('../src/automation/customer-inactivity');

assert.equal(policy.usageTriggered({noPlaybackEligible:true,usageEligible:false},{noPlaybackDays:7,minimumPlaybackMinutes:30}),false,'both configured Free Access rules must not trigger when only inactivity is met');
assert.equal(policy.usageTriggered({noPlaybackEligible:false,usageEligible:true},{noPlaybackDays:7,minimumPlaybackMinutes:30}),false,'both configured Free Access rules must not trigger when only low playback is met');
assert.equal(policy.usageTriggered({noPlaybackEligible:true,usageEligible:true},{noPlaybackDays:7,minimumPlaybackMinutes:30}),true,'both configured Free Access rules must trigger when both are met');
assert.equal(policy.usageTriggered({noPlaybackEligible:true,usageEligible:false},{noPlaybackDays:7,minimumPlaybackMinutes:null}),true,'a single configured inactivity rule must remain independently usable');
assert.equal(policy.usageTriggered({noPlaybackEligible:false,usageEligible:true},{noPlaybackDays:null,minimumPlaybackMinutes:30}),true,'a single configured playback rule must remain independently usable');
assert.equal(policy.usageTriggered({noPlaybackEligible:true,usageEligible:true},{noPlaybackDays:null,minimumPlaybackMinutes:null}),false,'no configured usage rules must never trigger removal');

const globalPolicy={enabled:true,dryRun:false,freeNoPlaybackDays:7};
assert.equal(policy.effectiveForFreePlan({},globalPolicy).noPlaybackDays,7,'Free plans must inherit the global no-playback window when they do not override it');
assert.equal(policy.effectiveForFreePlan({noPlaybackDays:4},globalPolicy).noPlaybackDays,4,'a Free plan must be able to override the global first-play/no-playback window');

const now=Date.parse('2026-09-07T12:00:00.000Z');
const noPlaybackPolicy={noPlaybackDays:4,minimumPlaybackMinutes:null,playbackWindowDays:7,minimumObservationHours:24};
const restored=inactivity.assessUsage({
  starts_at:'2026-08-01T12:00:00.000Z',
  account_created_at:'2026-08-01T12:00:00.000Z',
  allocation_start_at:'2026-09-05T12:00:00.000Z',
  last_playback_at:'2026-08-20T12:00:00.000Z',
  playback_seconds:0
},noPlaybackPolicy,now);
assert.equal(restored.lastPlaybackAt,null,'playback before the current allocation must not count as current Free Server playback');
assert.equal(restored.referenceAt.toISOString(),'2026-09-05T12:00:00.000Z','a restored user with no new playback must start the first-play clock from the new allocation');
assert.equal(restored.observationStartedAt.toISOString(),'2026-09-05T12:00:00.000Z','a restored Free allocation must receive a fresh observation window');
assert.equal(restored.noPlaybackEligible,false,'a returning user must not be immediately removed because of stale historical inactivity');

const currentPlayback=inactivity.assessUsage({
  allocation_start_at:'2026-09-01T12:00:00.000Z',
  last_playback_at:'2026-09-06T12:00:00.000Z',
  last_activity_at:'2020-01-01T00:00:00.000Z',
  playback_seconds:1800
},noPlaybackPolicy,now);
assert.equal(currentPlayback.referenceAt.toISOString(),'2026-09-06T12:00:00.000Z','actual playback in this allocation must reset the no-playback clock');
assert.equal(currentPlayback.noPlaybackEligible,false,'recent playback must keep the allocation inside the no-playback window');

const expiredFirstPlay=inactivity.assessUsage({allocation_start_at:'2026-09-03T11:00:00.000Z',last_playback_at:null,last_activity_at:'2026-09-07T11:00:00.000Z',playback_seconds:0},noPlaybackPolicy,now);
assert.equal(expiredFirstPlay.referenceAt.toISOString(),'2026-09-03T11:00:00.000Z','non-playback Jellyfin activity must not extend the first-play deadline');
assert.equal(expiredFirstPlay.noPlaybackEligible,true,'the first-play rule must become eligible after the configured allocation-scoped window');

const minimumPolicy={noPlaybackDays:null,minimumPlaybackMinutes:30,playbackWindowDays:7,minimumObservationHours:24};
assert.equal(inactivity.assessUsage({allocation_start_at:'2026-09-05T12:00:00.000Z',playback_seconds:0},minimumPolicy,now).usageEligible,false,'a fresh allocation must receive its full minimum-playback observation window');
assert.equal(inactivity.assessUsage({allocation_start_at:'2026-08-30T12:00:00.000Z',playback_seconds:29*60},minimumPolicy,now).usageEligible,true,'an observed allocation below its configured playback minimum must be eligible');
assert.equal(inactivity.assessUsage({allocation_start_at:'2026-08-30T12:00:00.000Z',playback_seconds:31*60},minimumPolicy,now).usageEligible,false,'an allocation meeting its configured playback minimum must remain safe');

const base=read('src/automation/customer-inactivity.js');
const status=read('src/automation/customer-inactivity-status.js');
const bulkOperations=read('src/platform/bulk-operations.js');
assert.match(base,/async function candidates\(globalCfg=null,\{customerId=null\}=\{\}\)/,'candidate discovery must support customer-scoped evaluation');
assert.match(base,/\(\$2::uuid IS NULL OR s\.customer_id=\$2::uuid\)/,'customer-scoped evaluation must be enforced in SQL instead of filtering a fleet-wide result');
assert.match(base,/MAX\(jal\.restored_at\).*restored_at/,'current allocation discovery must include explicit Free Server restoration time');
assert.match(base,/GREATEST\(fa\.starts_at,ja\.created_at,lifecycle\.restored_at\) allocation_start_at/,'allocation start must use the newest subscription/account/restoration boundary');
assert.match(base,/FILTER\(WHERE ph\.started_at>=allocation\.allocation_start_at\) last_playback_at/,'last playback must ignore sessions from previous Free allocations');
assert.match(base,/ph\.started_at>=GREATEST\(allocation\.allocation_start_at,NOW\(\)-/,'minimum-playback totals must be clipped to the current allocation as well as the rolling window');
assert.match(base,/const referenceAt=lastPlaybackAt\|\|allocationStartAt/,'no-playback timing must be driven by playback or the current allocation start, never generic account activity');
assert.match(base,/planPolicy\.usageTriggered\(assessment,policy\)/,'candidate eligibility must use the shared all-configured-rules policy');
assert.doesNotMatch(base,/assessment\.noPlaybackEligible\|\|assessment\.usageEligible/,'Free Access rules must not silently fall back to OR semantics');
assert.match(status,/scoped\.base\.candidates\(globalCfg,\{customerId\}\)/,'customer status must query only that customer through the worker base engine');
assert.match(status,/scoped\.refreshCandidateServers\(rows\)/,'customer status must refresh the same target server evidence used by enforcement');
assert.match(status,/rows=await scoped\.base\.candidates\(globalCfg,\{customerId\}\)/,'customer status must re-read activity after server refresh');
assert.match(bulkOperations,/COALESCE\(NULLIF\(s\.service_type_snapshot,''\),p\.service_type,'jellyfin'\) IN \('jellyfin','bundle'\)/,'admin bulk primary-plan fallback must never select standalone Stremio or Emby subscriptions');

console.log('Free Access inactivity consistency smoke: ok');
