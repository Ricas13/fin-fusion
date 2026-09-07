'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const policy=require('../src/entitlements/plan-lifecycle-policy');
const inactivity=require('../src/automation/customer-inactivity');

const retentionPolicy={firstPlaybackGraceDays:3,noPlaybackDays:7,minimumPlaybackMinutes:30,playbackWindowDays:7,minimumObservationHours:24};
assert.equal(policy.usageTriggered({hasPlayback:false,firstPlaybackEligible:false},retentionPolicy),false,'a fresh Free allocation must remain inside its first-play grace');
assert.equal(policy.usageTriggered({hasPlayback:false,firstPlaybackEligible:true},retentionPolicy),true,'an unactivated Free allocation must trigger independently when its first-play grace expires');
assert.equal(policy.usageTriggered({hasPlayback:true,noPlaybackEligible:true,usageEligible:false},retentionPolicy),false,'after activation both configured retention rules must not trigger when only inactivity is breached');
assert.equal(policy.usageTriggered({hasPlayback:true,noPlaybackEligible:false,usageEligible:true},retentionPolicy),false,'after activation both configured retention rules must not trigger when only low playback is breached');
assert.equal(policy.usageTriggered({hasPlayback:true,noPlaybackEligible:true,usageEligible:true},retentionPolicy),true,'after activation both configured retention rules must trigger when both are breached');
assert.equal(policy.usageTriggered({hasPlayback:true,noPlaybackEligible:true,usageEligible:false},{firstPlaybackGraceDays:null,noPlaybackDays:7,minimumPlaybackMinutes:null}),true,'a single configured inactivity rule must remain independently usable after activation');
assert.equal(policy.usageTriggered({hasPlayback:true,noPlaybackEligible:false,usageEligible:true},{firstPlaybackGraceDays:null,noPlaybackDays:null,minimumPlaybackMinutes:30}),true,'a single configured playback rule must remain independently usable after activation');
assert.equal(policy.usageTriggered({hasPlayback:true,noPlaybackEligible:true,usageEligible:true},{firstPlaybackGraceDays:null,noPlaybackDays:null,minimumPlaybackMinutes:null}),false,'no configured usage rules must never trigger removal');

const globalPolicy={enabled:true,dryRun:false,freeFirstPlaybackGraceDays:3,freeNoPlaybackDays:7,freeMinimumPlaybackMinutes:30,freePlaybackWindowDays:7};
const inherited=policy.effectiveForFreePlan({},globalPolicy);
assert.equal(inherited.firstPlaybackGraceDays,3,'Free plans must inherit the three-day first-play grace');
assert.equal(inherited.noPlaybackDays,7,'Free plans must inherit the seven-day recent-playback window');
assert.equal(inherited.minimumPlaybackMinutes,30,'Free plans must inherit the thirty-minute playback minimum');
assert.equal(inherited.playbackWindowDays,7,'Free plans must inherit the rolling seven-day playback window');
assert.equal(policy.effectiveForFreePlan({firstPlaybackGraceDays:2,noPlaybackDays:5,minimumPlaybackMinutes:45,playbackWindowDays:5},globalPolicy).firstPlaybackGraceDays,2,'a Free plan must be able to override its first-play grace');

const now=Date.parse('2026-09-07T12:00:00.000Z');
const restored=inactivity.assessUsage({
  starts_at:'2026-08-01T12:00:00.000Z',
  account_created_at:'2026-08-01T12:00:00.000Z',
  allocation_start_at:'2026-09-05T12:00:00.000Z',
  first_playback_at:'2026-08-10T12:00:00.000Z',
  last_playback_at:'2026-08-20T12:00:00.000Z',
  playback_seconds:0
},retentionPolicy,now);
assert.equal(restored.firstPlaybackAt,null,'first playback before the current allocation must not activate a restored Free place');
assert.equal(restored.lastPlaybackAt,null,'last playback before the current allocation must not count as current Free Server playback');
assert.equal(restored.hasPlayback,false,'a restored user must start unactivated even when historical playback exists');
assert.equal(restored.referenceAt.toISOString(),'2026-09-05T12:00:00.000Z','a restored user with no new playback must start from the new allocation');
assert.equal(restored.observationStartedAt.toISOString(),'2026-09-05T12:00:00.000Z','a restored Free allocation must receive a fresh activation window');
assert.equal(restored.firstPlaybackEligible,false,'a returning user must receive the full three-day first-play grace');
assert.equal(restored.noPlaybackEligible,false,'ongoing inactivity must not be evaluated before the first playback');
assert.equal(restored.usageEligible,false,'minimum-minute retention must not be evaluated before the first playback');

const expiredFirstPlay=inactivity.assessUsage({allocation_start_at:'2026-09-04T11:00:00.000Z',last_playback_at:null,last_activity_at:'2026-09-07T11:00:00.000Z',playback_seconds:0},retentionPolicy,now);
assert.equal(expiredFirstPlay.referenceAt.toISOString(),'2026-09-04T11:00:00.000Z','non-playback Jellyfin activity must not extend the first-play deadline');
assert.equal(expiredFirstPlay.firstPlaybackEligible,true,'the independent first-play rule must become eligible after three days');
assert.equal(expiredFirstPlay.noPlaybackEligible,false,'the seven-day retention clock must not substitute for the first-play rule');

const currentPlayback=inactivity.assessUsage({
  allocation_start_at:'2026-09-01T12:00:00.000Z',
  first_playback_at:'2026-09-02T12:00:00.000Z',
  last_playback_at:'2026-09-06T12:00:00.000Z',
  last_activity_at:'2020-01-01T00:00:00.000Z',
  playback_seconds:1800
},retentionPolicy,now);
assert.equal(currentPlayback.hasPlayback,true,'the first playback must switch the allocation into retention mode');
assert.equal(currentPlayback.observationStartedAt.toISOString(),'2026-09-02T12:00:00.000Z','the post-activation observation window must start from the first playback');
assert.equal(currentPlayback.referenceAt.toISOString(),'2026-09-06T12:00:00.000Z','actual playback in this allocation must reset the recent-playback clock');
assert.equal(currentPlayback.noPlaybackEligible,false,'recent playback must satisfy the seven-day activity check');
assert.equal(currentPlayback.usageEligible,false,'thirty minutes in the rolling window must satisfy the minimum-playback check');

const minimumPolicy={firstPlaybackGraceDays:3,noPlaybackDays:null,minimumPlaybackMinutes:30,playbackWindowDays:7,minimumObservationHours:24};
assert.equal(inactivity.assessUsage({allocation_start_at:'2026-08-30T12:00:00.000Z',first_playback_at:'2026-09-05T12:00:00.000Z',last_playback_at:'2026-09-05T12:00:00.000Z',playback_seconds:29*60},minimumPolicy,now).usageEligible,false,'the playback-minimum clock must start only after the first stream');
assert.equal(inactivity.assessUsage({allocation_start_at:'2026-08-20T12:00:00.000Z',first_playback_at:'2026-08-30T12:00:00.000Z',last_playback_at:'2026-09-01T12:00:00.000Z',playback_seconds:29*60},minimumPolicy,now).usageEligible,true,'an activated allocation below its configured playback minimum must become eligible after the full window');
assert.equal(inactivity.assessUsage({allocation_start_at:'2026-08-20T12:00:00.000Z',first_playback_at:'2026-08-30T12:00:00.000Z',last_playback_at:'2026-09-01T12:00:00.000Z',playback_seconds:31*60},minimumPolicy,now).usageEligible,false,'an activated allocation meeting its configured playback minimum must remain safe');

const base=read('src/automation/customer-inactivity.js');
const status=read('src/automation/customer-inactivity-status.js');
const adminPolicy=read('src/platform/admin-request-plan-policy.js');
const bulkOperations=read('src/platform/bulk-operations.js');
assert.match(base,/async function candidates\(globalCfg=null,\{customerId=null\}=\{\}\)/,'candidate discovery must support customer-scoped evaluation');
assert.match(base,/\(\$2::uuid IS NULL OR s\.customer_id=\$2::uuid\)/,'customer-scoped evaluation must be enforced in SQL instead of filtering a fleet-wide result');
assert.match(base,/MAX\(jal\.restored_at\).*restored_at/,'current allocation discovery must include explicit Free Server restoration time');
assert.match(base,/GREATEST\(fa\.starts_at,ja\.created_at,lifecycle\.restored_at\) allocation_start_at/,'allocation start must use the newest subscription/account/restoration boundary');
assert.match(base,/MIN\(ph\.started_at\) FILTER\(WHERE ph\.started_at>=allocation\.allocation_start_at\) first_playback_at/,'first playback must be scoped to the current Free allocation');
assert.match(base,/FILTER\(WHERE ph\.started_at>=allocation\.allocation_start_at\) last_playback_at/,'last playback must ignore sessions from previous Free allocations');
assert.match(base,/ph\.started_at>=GREATEST\(allocation\.allocation_start_at,NOW\(\)-/,'minimum-playback totals must be clipped to the current allocation as well as the rolling window');
assert.match(base,/firstPlaybackEligible=!hasPlayback&&policy\.firstPlaybackGraceDays!=null/,'the activation phase must be an explicit independent first-play check');
assert.match(base,/const noPlaybackEligible=hasPlayback&&policy\.noPlaybackDays!=null/,'ongoing inactivity must only start after activation');
assert.match(base,/const usageEligible=hasPlayback&&policy\.minimumPlaybackMinutes!=null/,'minimum playback must only start after activation');
assert.match(base,/planPolicy\.usageTriggered\(assessment,policy\)/,'candidate eligibility must use the shared phase-aware policy');
assert.match(status,/firstPlaybackAt:row\.first_playback_at\|\|null/,'customer status must expose first-play activation evidence to My Access');
assert.match(status,/allocationStartAt:row\.allocation_start_at\|\|null/,'customer status must expose the current allocation boundary to My Access');
assert.match(adminPolicy,/Free Server activity rules/,'the Free plan editor must expose the activity policy');
assert.match(adminPolicy,/name="firstPlaybackGraceDays"/,'the Free plan editor must expose first-play days');
assert.match(adminPolicy,/name="activityWindowDays"/,'the Free plan editor must expose the ongoing activity window');
assert.match(adminPolicy,/name="minimumPlaybackMinutes"/,'the Free plan editor must expose the playback minimum');
assert.match(adminPolicy,/noPlaybackDays:activityWindowDays,playbackWindowDays:activityWindowDays/,'the admin activity window must drive both recency and rolling playback windows');
assert.match(adminPolicy,/Restoring access starts a fresh activation window and old playback is ignored/,'the Free plan UI must explain restored-allocation semantics');
assert.match(bulkOperations,/COALESCE\(NULLIF\(s\.service_type_snapshot,''\),p\.service_type,'jellyfin'\) IN \('jellyfin','bundle'\)/,'admin bulk primary-plan fallback must never select standalone Stremio or Emby subscriptions');

console.log('Free Access inactivity consistency smoke: ok');
