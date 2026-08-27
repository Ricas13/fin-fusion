'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const policy=require('../src/entitlements/plan-lifecycle-policy');

assert.equal(policy.usageTriggered({noPlaybackEligible:true,usageEligible:false},{noPlaybackDays:7,minimumPlaybackMinutes:30}),false,'both configured Free Access rules must not trigger when only inactivity is met');
assert.equal(policy.usageTriggered({noPlaybackEligible:false,usageEligible:true},{noPlaybackDays:7,minimumPlaybackMinutes:30}),false,'both configured Free Access rules must not trigger when only low playback is met');
assert.equal(policy.usageTriggered({noPlaybackEligible:true,usageEligible:true},{noPlaybackDays:7,minimumPlaybackMinutes:30}),true,'both configured Free Access rules must trigger when both are met');
assert.equal(policy.usageTriggered({noPlaybackEligible:true,usageEligible:false},{noPlaybackDays:7,minimumPlaybackMinutes:null}),true,'a single configured inactivity rule must remain independently usable');
assert.equal(policy.usageTriggered({noPlaybackEligible:false,usageEligible:true},{noPlaybackDays:null,minimumPlaybackMinutes:30}),true,'a single configured playback rule must remain independently usable');
assert.equal(policy.usageTriggered({noPlaybackEligible:true,usageEligible:true},{noPlaybackDays:null,minimumPlaybackMinutes:null}),false,'no configured usage rules must never trigger removal');

const base=read('src/automation/customer-inactivity.js');
const status=read('src/automation/customer-inactivity-status.js');
assert.match(base,/async function candidates\(globalCfg=null,\{customerId=null\}=\{\}\)/,'candidate discovery must support customer-scoped evaluation');
assert.match(base,/\(\$2::uuid IS NULL OR s\.customer_id=\$2::uuid\)/,'customer-scoped evaluation must be enforced in SQL instead of filtering a fleet-wide result');
assert.match(base,/planPolicy\.usageTriggered\(assessment,policy\)/,'candidate eligibility must use the shared all-configured-rules policy');
assert.doesNotMatch(base,/assessment\.noPlaybackEligible\|\|assessment\.usageEligible/,'Free Access rules must not silently fall back to OR semantics');
assert.match(status,/scoped\.base\.candidates\(globalCfg,\{customerId\}\)/,'customer status must query only that customer through the worker base engine');
assert.match(status,/scoped\.refreshCandidateServers\(rows\)/,'customer status must refresh the same target server evidence used by enforcement');
assert.match(status,/rows=await scoped\.base\.candidates\(globalCfg,\{customerId\}\)/,'customer status must re-read activity after server refresh');

console.log('Free Access inactivity consistency smoke: ok');
