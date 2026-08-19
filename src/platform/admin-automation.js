'use strict';

const express = require('express');
const { query } = require('../db');
const csrf = require('../auth/csrf');
const jobHealth = require('../automation/job-health');
const { layout, esc } = require('./admin-html');
const runtimeSettings = require('./runtime-settings');

const LABELS = {
    health: ['Jellyfin health', 'Checks configured servers and updates health status.'],
    entitlements: ['Entitlements', 'Expires due subscriptions and reconciles active customer access.'],
    policy_drift: ['Jellyfin policy drift', 'Read-only comparison of CAPTAiNFiN policy with live managed Jellyfin users.'],
    customer_inactivity: ['Customer inactivity', 'Applies configured Jellyfin inactivity and cleanup rules.'],
    bulk_jobs: ['Bulk operations', 'Processes queued bulk customer actions.'],
    stale_reclaim: ['Stale job reclaim', 'Recovers abandoned running bulk items safely.'],
    email_outbox: ['Transactional email', 'Delivers due messages from the encrypted outbox.'],
    notification_outbox: ['Notification delivery', 'Delivers due customer and administrator notifications.'],
    request_users: ['Request users', 'Synchronises CAPTAiNFiN customer access to Seerr/Overseerr.'],
    billing: ['Customer billing', 'Re-verifies recurring direct-customer provider subscriptions.'],
    plan_changes: ['Customer plan changes', 'Applies any provider-confirmed or due direct-customer plan transitions.'],
    referral_rewards: ['Affiliate rewards', 'Qualifies pending referrals and matures eligible service credit.'],
    activation_cleanup: ['Activation cleanup', 'Cleans abandoned customer activation state.'],
    pending_registration_cleanup: ['Registration cleanup', 'Removes expired staged public registrations.'],
    stremio_media_index: ['Stremio media index', 'Refreshes managed and external Stremio catalogue indexes.']
};
const CORE_JOBS=new Set(['health','entitlements','billing','plan_changes','stale_reclaim']);
const GROUPS=[
    ['Access & servers','Core jobs that keep customer access, Jellyfin health and policy reconciliation moving.',new Set(['health','entitlements','policy_drift','customer_inactivity','stremio_media_index'])],
    ['Commerce','Billing, plan transitions and affiliate-credit background work.',new Set(['billing','plan_changes','referral_rewards'])],
    ['Messaging & onboarding','Activation cleanup, public registration cleanup, transactional email, notifications and request-service sync.',new Set(['activation_cleanup','pending_registration_cleanup','email_outbox','notification_outbox','request_users'])],
    ['Operations','Bulk work queues and stale-job recovery.',new Set(['bulk_jobs','stale_reclaim'])]
];
const PRESETS=[60,300,900,1800,3600,10800,21600,43200,86400];

function gate(req,res,next){ return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId ? next() : res.redirect('/login?session=expired'); }
function noStore(_req,res,next){ res.setHeader('Cache-Control','no-store, private, max-age=0'); res.setHeader('Pragma','no-cache'); next(); }
function dt(value){ return value ? new Date(value).toLocaleString('en-GB') : 'Never'; }
function duration(value){ return value==null ? '—' : Number(value)<1000 ? `${value} ms` : `${(Number(value)/1000).toFixed(1)} s`; }
function intervalLabel(seconds){ const n=Number(seconds||0); if(n%86400===0)return `${n/86400} day${n===86400?'':'s'}`; if(n%3600===0)return `${n/3600} hour${n===3600?'':'s'}`; if(n%60===0)return `${n/60} minute${n===60?'':'s'}`; return `${n} seconds`; }
function notice(req){ return `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`; }
function token(req){ return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`; }
function statePill(state){const cls=state==='healthy'?'good':state==='failed'||state==='stale'||state==='missing'?'bad':state==='disabled'?'warn':'';return `<span class="pill ${cls}">${esc(String(state).replace('_',' '))}</span>`}
function scheduleOptions(value){const current=Number(value||0),values=[...new Set([...PRESETS,current].filter(n=>n>=30&&n<=86400))].sort((a,b)=>a-b);return values.map(n=>`<option value="${n}" ${n===current?'selected':''}>Every ${esc(intervalLabel(n))}</option>`).join('')}
function groupFor(jobKey){return GROUPS.find(([, ,keys])=>keys.has(jobKey))||['Other','Less common background work.',new Set()]}

async function workerState(){const result=await query(`SELECT *,EXTRACT(EPOCH FROM (NOW()-last_heartbeat_at))::int heartbeat_age_seconds FROM operational_worker_state WHERE worker_key='automation'`);return result.rows[0]||null}
async function page(req) {
    await runtimeSettings.ensureLoaded();
    const [jobs,worker] = await Promise.all([jobHealth.list(),workerState()]);
    const cards = jobs.map(job => {
        const [name,description] = LABELS[job.job_key] || [job.job_key,'Background platform task'];
        const state=jobHealth.healthState(job),core=CORE_JOBS.has(job.job_key);
        return {group:groupFor(job.job_key)[0],html:`<article class="serverCard automationJobCard"><div class="serverTop"><div><strong>${esc(name)}</strong>${core?' <span class="pill warn">Core</span>':''}<div class="subText">${esc(description)}</div></div>${statePill(state)}</div>
            <div class="serverStats"><div><span class="metricMini">${esc(intervalLabel(job.interval_seconds))}</span><span class="subText">schedule</span></div><div><span class="metricMini">${esc(job.last_processed_count==null?'—':job.last_processed_count)}</span><span class="subText">last processed</span></div><div><span class="metricMini">${esc(job.consecutive_failures||0)}</span><span class="subText">failures</span></div></div>
            <div class="kvList"><div class="kvRow"><div class="kvLabel">Last start</div><div class="kvValue">${esc(dt(job.last_started_at))}</div></div><div class="kvRow"><div class="kvLabel">Last success</div><div class="kvValue">${esc(dt(job.last_success_at))}</div></div><div class="kvRow"><div class="kvLabel">Duration</div><div class="kvValue">${esc(duration(job.last_duration_ms))}</div></div><div class="kvRow"><div class="kvLabel">Next run</div><div class="kvValue">${esc(dt(job.next_run_at))}</div></div></div>
            ${job.force_run_requested?'<div class="notice">Manual run requested; the worker will execute this once even if its recurring schedule is disabled.</div>':''}${job.last_error?`<div class="notice error"><strong>Last error:</strong> ${esc(job.last_error)}</div>`:''}${core?'<div class="securityNote standalone"><strong>Core service job:</strong> disabling this can interrupt access, billing or server-state maintenance. Prefer changing the schedule only when you understand the operational effect.</div>':''}
            <form class="formPanel" method="post" action="/admin/automation/${encodeURIComponent(job.job_key)}"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><div class="formGrid"><div class="formGroup"><label>Schedule</label><select class="input" name="intervalSeconds">${scheduleOptions(job.interval_seconds)}</select><div class="inlineHelp">Common schedules are shown in plain language. Existing custom values remain selectable.</div></div><label class="checkRow"><input type="checkbox" name="enabled" value="1" ${job.enabled?'checked':''}> Enabled</label></div>${core&&job.enabled?'<div class="formGroup"><label>Disable confirmation <span class="muted">(only required when turning this core job off)</span></label><input class="input" name="disableConfirmation" autocomplete="off" placeholder="Type DISABLE"></div>':''}<button class="button secondary btn-sm">Save schedule</button></form>
            <form method="post" action="/admin/automation/${encodeURIComponent(job.job_key)}/run">${token(req)}<button class="button btn-sm">Run now${job.enabled?'':' once'}</button></form></article>`};
    });
    const groupedSections=GROUPS.concat([['Other','Less common background work.',new Set()]]).map(([title,description])=>{
        const rows=cards.filter(card=>card.group===title);
        if(!rows.length)return '';
        return `<section class="section automationGroup"><div class="sectionHead"><div><h2>${esc(title)}</h2><div class="muted">${esc(description)}</div></div><span class="pill">${rows.length} job${rows.length===1?'':'s'}</span></div><div class="serverGrid">${rows.map(row=>row.html).join('')}</div></section>`;
    }).join('');
    const states=jobs.map(job=>jobHealth.healthState(job));
    const unhealthy=states.filter(state=>['failed','stale','missing'].includes(state)).length;
    const disabled=states.filter(state=>state==='disabled').length;
    const healthy=states.filter(state=>state==='healthy').length;
    const workerAlive=Boolean(worker&&Number(worker.heartbeat_age_seconds)<=Math.max(60,Math.ceil(Number(worker?.metadata?.pollMs||15000)/1000)*4));
    const workerBanner=worker?`<div class="statusBanner"><strong>Automation worker:</strong> ${workerAlive?'<span class="pill good">alive</span>':'<span class="pill bad">stale</span>'} · instance ${esc(worker.instance_id)} · version ${esc(worker.version||'unknown')} · heartbeat ${esc(worker.heartbeat_age_seconds)}s ago${worker.draining_at?` · draining since ${esc(dt(worker.draining_at))}`:''}.</div>`:'<div class="notice error"><strong>Automation worker heartbeat missing.</strong> The job configuration exists, but no current worker has registered itself.</div>';
    return layout({siteName:runtimeSettings.siteName(),active:'automation-jobs',title:'Automation',subtitle:'Schedules, singleton locks and live worker health',body:`${notice(req)}<div class="metrics"><div class="metric"><div class="metricLabel">Jobs</div><div class="metricValue">${jobs.length}</div></div><div class="metric"><div class="metricLabel">Healthy</div><div class="metricValue">${healthy}</div></div><div class="metric"><div class="metricLabel">Needs attention</div><div class="metricValue">${unhealthy}</div></div><div class="metric"><div class="metricLabel">Disabled</div><div class="metricValue">${disabled}</div></div></div>${workerBanner}<div class="operatorCallout"><strong>Manual controls are grouped by operational area.</strong> Use Run now for diagnosis or catch-up work; normal service should be driven by the schedule.</div>${groupedSections}`});
}

function createAdminAutomationRouter(){
    const router=express.Router();
    router.use('/admin/automation',gate,noStore);
    router.get('/admin/automation',async(req,res,next)=>{try{return res.send(await page(req));}catch(error){next(error);}});
    router.post('/admin/automation/:job',async(req,res)=>{
        if(!csrf.verify(req))return res.status(403).send('Invalid security token');
        try{
            const current=(await jobHealth.list()).find(job=>job.job_key===req.params.job);
            if(!current)throw new Error('Unknown automation job.');
            const enabled=req.body.enabled==='1';
            if(CORE_JOBS.has(req.params.job)&&current.enabled&&!enabled&&String(req.body.disableConfirmation||'').trim().toUpperCase()!=='DISABLE')throw new Error('Type DISABLE to turn off this core service job.');
            await jobHealth.update(req.params.job,{enabled,intervalSeconds:req.body.intervalSeconds});
            return res.redirect('/admin/automation?message='+encodeURIComponent('Automation schedule saved.'));
        } catch(error){return res.redirect('/admin/automation?error='+encodeURIComponent(error.message));}
    });
    router.post('/admin/automation/:job/run',async(req,res)=>{
        if(!csrf.verify(req))return res.status(403).send('Invalid security token');
        try{const job=await jobHealth.requestRun(req.params.job);return res.redirect('/admin/automation?message='+encodeURIComponent(job.enabled?'Job queued to run on the next worker poll.':'One-time forced run queued; the recurring schedule remains disabled.'));}
        catch(error){return res.redirect('/admin/automation?error='+encodeURIComponent(error.message));}
    });
    return router;
}

module.exports={createAdminAutomationRouter,page,LABELS,CORE_JOBS,workerState};
