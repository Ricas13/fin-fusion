'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const verifier = require('./verify-deployment');
const jobRegistry = require('../src/automation/jobs');

const workerStartedAt = '2026-09-13T12:00:00.000Z';

assert.strictEqual(verifier.probeSucceededSince({
    last_outcome: 'success',
    last_success_at: '2026-09-13T12:00:05.000Z'
}, workerStartedAt), true, 'a successful recovery run after worker startup must prove the deployed release');

assert.strictEqual(verifier.probeSucceededSince({
    last_outcome: 'success',
    last_success_at: '2026-09-13T11:59:59.000Z'
}, workerStartedAt), false, 'a success from the previous worker/release must not satisfy deployment proof');

assert.strictEqual(verifier.probeSucceededSince({
    last_outcome: 'degraded',
    last_success_at: '2026-09-13T12:00:05.000Z'
}, workerStartedAt), false, 'a later degraded outcome must fail closed even when an earlier success is recent');

assert.strictEqual(verifier.probeSatisfiedSince('revenue_integrity', {
    last_outcome: 'degraded',
    last_completed_at: '2026-09-13T12:00:05.000Z',
    last_success_at: '2026-09-12T12:00:05.000Z'
}, workerStartedAt), true,
'revenue integrity degraded means the scanner completed under this release and must be handed to operator acceptance rather than treated as an execution failure');

assert.strictEqual(verifier.probeSatisfiedSince('customer_service_recovery', {
    last_outcome: 'degraded',
    last_completed_at: '2026-09-13T12:00:05.000Z',
    last_success_at: '2026-09-13T12:00:05.000Z'
}, workerStartedAt), false,
'other critical recovery jobs must continue to fail closed on degraded outcomes');

assert.strictEqual(verifier.probeSatisfiedSince('revenue_integrity', {
    last_outcome: 'failed',
    last_completed_at: '2026-09-13T12:00:05.000Z'
}, workerStartedAt), false,
'a failed revenue integrity execution must still block deployment');

assert.strictEqual(verifier.deploymentJobBlocks('revenue_integrity', 'degraded'), false,
'revenue integrity findings belong to production acceptance rather than deployment rollback');
assert.strictEqual(verifier.deploymentJobBlocks('revenue_integrity', 'failed'), true,
'revenue integrity execution failures must still block deployment');
assert.strictEqual(verifier.deploymentJobBlocks('billing', 'degraded'), true,
'degraded non-integrity critical jobs must remain deployment blockers');

const diagnostic = verifier.formatProbeSnapshot({
    jobKey: 'revenue_integrity',
    state: 'healthy',
    successAt: '2026-09-13T12:00:05.000Z',
    completedAt: '2026-09-13T12:00:05.000Z',
    lastStartedAt: '2026-09-13T12:00:04.000Z',
    forceRunRequested: false,
    requiredSince: workerStartedAt
});
for (const token of ['state=healthy', 'success=', 'completed=', 'started=', 'force=false', 'required_since=']) {
    assert(diagnostic.includes(token), `timeout diagnostics must include ${token}`);
}

assert.strictEqual(jobRegistry.isCritical('customer_inactivity'), true,
    'customer inactivity cleanup must remain registered as access-critical capability');
assert.strictEqual(jobRegistry.mayBeDisabled('customer_inactivity'), true,
    'customer inactivity cleanup must support intentional operator disablement');
assert.strictEqual(jobRegistry.mayBeDisabled('revenue_integrity'), false,
    'revenue integrity must remain required-enabled');
assert(verifier.DEPLOYMENT_PROBE_JOBS.includes('free_capacity_backfill'),
    'free-capacity recovery must be explicitly proved under the candidate worker before cutover');

const staleBeforeRestart={
    enabled:true,
    interval_seconds:300,
    last_started_at:'2026-09-13T11:30:00.000Z',
    last_completed_at:'2026-09-13T11:30:01.000Z',
    last_outcome:'success'
};
assert.strictEqual(
    verifier.deploymentCriticalState(staleBeforeRestart,'2026-09-13T12:00:00.000Z',new Date('2026-09-13T12:02:00.000Z').getTime()),
    'warming',
    'old stale state must get one scheduler interval to warm up after a fresh worker starts'
);
assert.strictEqual(
    verifier.deploymentCriticalState(staleBeforeRestart,'2026-09-13T12:00:00.000Z',new Date('2026-09-13T12:06:00.000Z').getTime()),
    'stale',
    'a critical job that remains stale beyond worker warm-up must still block deployment'
);

const proofNow=new Date('2026-09-13T12:02:00.000Z').getTime();
const proofRow=(job_key,overrides={})=>({job_key,...staleBeforeRestart,...overrides});
const orphanedRun={last_started_at:'2026-09-13T11:59:00.000Z',last_completed_at:'2026-09-13T11:54:00.000Z'};
assert.deepStrictEqual(verifier.deploymentProofCandidates([proofRow('customer_inactivity')],workerStartedAt,proofNow),
    ['customer_inactivity'],
    'a job left stale by the previous worker must be proved even inside the candidate warm-up window');
assert.deepStrictEqual(verifier.deploymentProofCandidates([proofRow('entitlements',orphanedRun)],workerStartedAt,proofNow),
    ['entitlements'],'a run orphaned by the previous worker must be proved');
assert.deepStrictEqual(verifier.deploymentProofCandidates([
    proofRow('entitlements',{last_started_at:'2026-09-13T12:01:00.000Z',last_completed_at:'2026-09-13T11:54:00.000Z'}),
    proofRow('billing',{last_started_at:'2026-09-13T12:01:00.000Z',last_completed_at:'2026-09-13T12:01:05.000Z'}),
    proofRow('payment_events',{last_outcome:'failed',last_error:'boom'})
],workerStartedAt,proofNow),[],
'a run owned by the candidate worker, a healthy job and a failed job (handled by the repair rule) are not freshness candidates');
assert.deepStrictEqual(verifier.deploymentProofCandidates([
    proofRow('customer_inactivity',{enabled:false}),
    proofRow('customer_inactivity',{enabled:false,force_run_requested:true}),
    proofRow('entitlements',{enabled:false,...orphanedRun})
],workerStartedAt,proofNow),[],'operator-disabled jobs must never be force-run');
assert.deepStrictEqual(verifier.deploymentProofCandidates(
    [...verifier.DEPLOYMENT_PROBE_JOBS.map(jobKey=>proofRow(jobKey)),proofRow('stremio_media_index')],
    workerStartedAt,proofNow),[],
'recovery probe jobs have their own pass and non-critical jobs do not gate a deployment');
assert.strictEqual(verifier.deploymentProofTimeoutMs(undefined),180000);
assert.strictEqual(verifier.deploymentProofTimeoutMs('nonsense'),180000);
assert.strictEqual(verifier.deploymentProofTimeoutMs('1000'),30000);
assert.strictEqual(verifier.deploymentProofTimeoutMs('240000'),240000);
assert.strictEqual(verifier.deploymentProofTimeoutMs('86400000'),900000);

const longOrphan={last_started_at:'2026-09-13T09:00:00.000Z',last_completed_at:'2026-09-13T08:00:00.000Z'};
assert.deepStrictEqual(verifier.deploymentProofCandidates([proofRow('entitlements',longOrphan)],workerStartedAt,proofNow),
    ['entitlements'],'an orphaned run old enough to be stuck must still be proved');
assert.deepStrictEqual(verifier.deploymentProofCandidates([proofRow('entitlements',{
    last_started_at:'2026-09-13T12:00:30.000Z',last_completed_at:'2026-09-13T11:00:00.000Z'
})],workerStartedAt,new Date('2026-09-13T14:00:00.000Z').getTime()),[],
'a stuck run owned by the candidate worker is reported, not forced');

const requestedAt='2026-09-13T12:03:00.000Z';
const runStatus=row=>verifier.overdueRunStatus(row,requestedAt);
assert.strictEqual(runStatus({last_started_at:'2026-09-13T12:02:59.000Z',last_completed_at:'2026-09-13T12:03:30.000Z',last_outcome:'success'}),
    'not_started','a run that started before the request proves nothing even when it finishes after it');
assert.strictEqual(runStatus({}),'not_started');
assert.strictEqual(runStatus({last_started_at:'2026-09-13T12:03:00.000Z',last_completed_at:'2026-09-13T11:00:00.000Z'}),'running');
for(const outcome of ['success','degraded','failed']){
    assert.strictEqual(runStatus({last_started_at:'2026-09-13T12:03:01.000Z',last_completed_at:'2026-09-13T12:03:02.000Z',last_outcome:outcome}),outcome);
}

const source = fs.readFileSync(path.join(__dirname, 'verify-deployment.js'), 'utf8');
assert(source.includes('await proveCriticalAutomation({'),
    'deployment verification must apply the critical automation release rules');
assert(source.includes('!overdueKeys.has(job.job_key)'),
    'overdue jobs must be judged by their requested run rather than by restart state');
assert(source.includes('deploymentCriticalState(inactivityJob, automationWorker?.started_at)')
    && source.includes('!badStates.has(inactivityState) && !inactivityUnproven'),
    'inactivity policy must be evaluated after the proof and must not hide a failed proof behind warm-up');
assert(source.includes('workerStartedAt: automationWorker.started_at'),
    'deployment recovery proof must be anchored to the current automation worker start');
assert(source.includes('proveBlockingCriticalJobs({'),'deployment verification must re-run historical degraded/failed critical jobs under the candidate release before rejecting the release');
assert(source.includes("['failed','degraded'].includes(state)"),'candidate repair proof must target prior failed/degraded critical state rather than weakening healthy/stale policy globally');
assert(source.includes("String(row?.last_outcome || '') === 'success'")&&source.includes('timestamp(row?.last_success_at) >= timestamp(marker)'),'candidate repair proof must require a fresh success completed after the force-run marker');
assert(source.includes('AND draining_at IS NULL'),
    'deployment verification must ignore worker instances that are already draining');
assert(source.includes("add('critical automation job enablement'"),
    'deployment verification must distinguish missing critical jobs from unexpected disablement');
assert(source.includes("add('revenue integrity execution'"),
    'deployment verification must report revenue integrity as an explicit operator-attention lane');
assert(source.includes("add('Free Server inactivity cleanup policy'"),
    'inactivity cleanup must be reported as an operator policy rather than the whole Free Server lifecycle');
assert(source.includes("deploymentCriticalState(freeBackfillJob, automationWorker?.started_at)"),
    'free-capacity recovery health must honor candidate-worker warm-up semantics after restart');
assert(!source.includes("add('Free Server lifecycle job'"),
    'the misleading Free Server lifecycle job blocker label must not return');
assert(source.includes('if (require.main === module)'),
    'deployment verifier must be import-safe so release-policy helpers can be tested without running production checks');

const minutesAgo=minutes=>new Date(Date.now()-minutes*60000);

// Runs the release rules against an in-memory job table. A reaction is what the
// candidate worker does with a job once its run has been requested.
async function release(jobSpecs,{disableOnSelect=[]}={}){
    const jobHealth=require('../src/automation/job-health');
    const originals={requestRun:jobHealth.requestRun,list:jobHealth.list};
    const rows=new Map(),reactions=new Map(),requests=[],checks=[];
    for(const[jobKey,spec]of Object.entries(jobSpecs)){
        rows.set(jobKey,{job_key:jobKey,enabled:true,interval_seconds:300,last_outcome:'success',
            last_started_at:minutesAgo(30),last_completed_at:minutesAgo(29),last_success_at:minutesAgo(29),...spec.row});
        reactions.set(jobKey,spec.react||(()=>{}));
    }
    const selected=[...rows.values()].map(row=>({...row}));
    for(const jobKey of disableOnSelect)rows.get(jobKey).enabled=false;
    jobHealth.requestRun=async(jobKey,{enabledOnly=false}={})=>{
        const row=rows.get(jobKey);
        assert.strictEqual(enabledOnly,true,'automated release requests must never include disabled jobs');
        if(!row.enabled)return null;
        requests.push(jobKey);
        const updated_at=new Date();
        const react = reactions.get(jobKey);
        assert.strictEqual(typeof react, 'function', 'requested job must have a registered test reaction');
        if (typeof react !== 'function') throw new Error('Missing test reaction');
        react(row,updated_at.getTime());
        return{...row,updated_at};
    };
    jobHealth.list=async()=>[...rows.values()].map(row=>({...row}));
    try{
        const proof=await verifier.proveCriticalAutomation({
            jobs:selected,workerStartedAt:minutesAgo(0.1),inactivityTimeoutMs:80,observationMs:80,pollMs:10,
            add:(name,ok,detail,options={})=>checks.push({name,ok,detail,warn:Boolean(options.warn)})
        });
        return{...proof,requests,checks:new Map(checks.map(check=>[check.name,check]))};
    }finally{
        Object.assign(jobHealth,originals);
    }
}

const ran=outcome=>(row,at)=>Object.assign(row,{last_started_at:new Date(at+1),
    ...(outcome==='running'?{}:{last_completed_at:new Date(at+2),last_outcome:outcome,
        ...(outcome==='success'?{last_success_at:new Date(at+2)}:{}),
        ...(outcome==='failed'?{last_error:'boom'}:{})})});
const startedEarlier=outcome=>(row,at)=>Object.assign(row,{last_started_at:new Date(at-1000),
    last_completed_at:new Date(at+2),last_outcome:outcome});

async function proofBehaviour(){
    const warned=await release({
        billing:{react:ran('success')},
        payment_events:{react:ran('running')},
        plan_changes:{react:ran('degraded')},
        email_outbox:{},
        notification_outbox:{react:startedEarlier('failed')}
    });
    const overdue=warned.checks.get('overdue critical automation');
    assert.strictEqual(overdue.ok,true,'running, degraded, unstarted and pre-request runs must not block');
    assert.strictEqual(overdue.warn,true);
    for(const token of ['billing:success','payment_events:running','plan_changes:degraded','email_outbox:not_started','notification_outbox:not_started']){
        assert(overdue.detail.includes(token),`warning must report ${token}`);
    }
    assert.strictEqual(warned.overdueKeys.size,5);
    assert.strictEqual(warned.inactivityProof,null);
    assert.strictEqual(warned.checks.has('critical automation repair probe'),false);

    const failed=await release({billing:{react:ran('failed')},payment_events:{react:ran('success')}});
    assert.strictEqual(failed.checks.get('overdue critical automation').ok,false,'a failed requested run must block');
    assert(failed.checks.get('overdue critical automation').detail.includes('billing:failed error=boom'));

    const forgotten=await release({
        billing:{react:(row,at)=>{ran('failed')(row,at);setTimeout(()=>ran('running')(row,at+5),25);}},
        payment_events:{}
    });
    assert.strictEqual(forgotten.checks.get('overdue critical automation').ok,false,
        'a later run must not erase an observed failure');

    for(const[reaction,expected]of[[ran('running'),'running'],[ran('success'),'success'],[ran('degraded'),'degraded'],
        [ran('failed'),'failed'],[()=>{},'not_started'],[startedEarlier('success'),'not_started']]){
        const result=await release({customer_inactivity:{react:reaction}});
        assert.strictEqual(result.inactivityProof,expected);
        assert.strictEqual(result.overdueKeys.has('customer_inactivity'),false,
            'inactivity cleanup keeps its own blocking rule');
    }

    let billingRequestedEarly=null;
    const ordered=await release({
        billing:{react:ran('success')},
        health:{row:{last_outcome:'failed',last_error:'old'},react:(row,at)=>{
            billingRequestedEarly=false;
            setTimeout(()=>ran('success')(row,at),30);
        }},
        customer_inactivity:{react:ran('running')}
    });
    assert.deepStrictEqual(ordered.requests,['customer_inactivity','health','billing'],
        'inactivity is requested first and other overdue jobs only after the strict proof');
    assert.strictEqual(billingRequestedEarly,false);
    assert.strictEqual(ordered.checks.get('critical automation repair probe').ok,true);

    const unrepaired=await release({health:{row:{last_outcome:'failed',last_error:'old'},react:ran('degraded')}});
    assert.strictEqual(unrepaired.checks.get('critical automation repair probe').ok,false,
        'a historical blocker still requires a fresh success');

    const disabled=await release({
        customer_inactivity:{row:{enabled:false}},
        billing:{row:{enabled:false}},
        payment_events:{},
        health:{row:{last_outcome:'failed'}}
    },{disableOnSelect:['payment_events','health']});
    assert.deepStrictEqual(disabled.requests,[],'no release rule may force a disabled job');
    assert.strictEqual(disabled.overdueKeys.size,0);
    assert.strictEqual(disabled.inactivityProof,null);
}

proofBehaviour().then(()=>console.log('deployment verification policy smoke: ok')).catch(error=>{console.error(error);process.exit(1);});
