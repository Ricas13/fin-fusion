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
    bulk_jobs: ['Bulk operations', 'Processes queued bulk customer actions.'],
    stale_reclaim: ['Stale job reclaim', 'Recovers abandoned running bulk items safely.'],
    email_outbox: ['Transactional email', 'Delivers due messages from the encrypted outbox.'],
    request_users: ['Request users', 'Synchronises CAPTAiNFiN customer access to Seerr/Overseerr.'],
    billing: ['Customer billing', 'Re-verifies recurring direct-customer provider subscriptions.'],
    plan_changes: ['Customer plan changes', 'Applies any provider-confirmed or due direct-customer plan transitions.'],
    reseller_billing: ['Reseller billing', 'Re-verifies Stripe/PayPal reseller subscriptions and applies due tier changes.'],
    reseller_estates: ['Reseller estates', 'Applies parent reseller entitlement changes to child customers.'],
    reseller_notifications: ['Reseller lifecycle notifications', 'Emits billing, grace, estate and seat-utilisation transition notifications without blocking billing.']
};

function gate(req,res,next){ return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId ? next() : res.redirect('/login?session=expired'); }
function noStore(_req,res,next){ res.setHeader('Cache-Control','no-store, private, max-age=0'); res.setHeader('Pragma','no-cache'); next(); }
function dt(value){ return value ? new Date(value).toLocaleString('en-GB') : 'Never'; }
function duration(value){ return value==null ? '—' : Number(value)<1000 ? `${value} ms` : `${(Number(value)/1000).toFixed(1)} s`; }
function intervalLabel(seconds){ const n=Number(seconds||0); if(n%3600===0)return `${n/3600}h`; if(n%60===0)return `${n/60}m`; return `${n}s`; }
function notice(req){ return `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`; }
function token(req){ return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`; }
function statePill(state){const cls=state==='healthy'?'good':state==='failed'||state==='stale'||state==='missing'?'bad':state==='disabled'?'warn':'';return `<span class="pill ${cls}">${esc(String(state).replace('_',' '))}</span>`}

async function workerState(){const result=await query(`SELECT *,EXTRACT(EPOCH FROM (NOW()-last_heartbeat_at))::int heartbeat_age_seconds FROM operational_worker_state WHERE worker_key='automation'`);return result.rows[0]||null}
async function page(req) {
    await runtimeSettings.ensureLoaded();
    const [jobs,worker] = await Promise.all([jobHealth.list(),workerState()]);
    const cards = jobs.map(job => {
        const [name,description] = LABELS[job.job_key] || [job.job_key,'Background platform task'];
        const state=jobHealth.healthState(job);
        return `<article class="serverCard"><div class="serverTop"><div><strong>${esc(name)}</strong><div class="subText">${esc(description)}</div></div>${statePill(state)}</div>
            <div class="serverStats"><div><span class="metricMini">${esc(intervalLabel(job.interval_seconds))}</span><span class="subText">interval</span></div><div><span class="metricMini">${esc(job.last_processed_count==null?'—':job.last_processed_count)}</span><span class="subText">last processed</span></div><div><span class="metricMini">${esc(job.consecutive_failures||0)}</span><span class="subText">failures</span></div></div>
            <div class="kvList"><div class="kvRow"><div class="kvLabel">Last start</div><div class="kvValue">${esc(dt(job.last_started_at))}</div></div><div class="kvRow"><div class="kvLabel">Last success</div><div class="kvValue">${esc(dt(job.last_success_at))}</div></div><div class="kvRow"><div class="kvLabel">Duration</div><div class="kvValue">${esc(duration(job.last_duration_ms))}</div></div><div class="kvRow"><div class="kvLabel">Next run</div><div class="kvValue">${esc(dt(job.next_run_at))}</div></div></div>
            ${job.force_run_requested?'<div class="notice">Manual run requested; the worker will execute this once even if its recurring schedule is disabled.</div>':''}${job.last_error?`<div class="notice error"><strong>Last error:</strong> ${esc(job.last_error)}</div>`:''}
            <form class="formPanel" method="post" action="/admin/automation/${encodeURIComponent(job.job_key)}"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><div class="formGrid"><div class="formGroup"><label>Interval seconds</label><input class="input" type="number" min="30" max="86400" name="intervalSeconds" value="${esc(job.interval_seconds)}"></div><label class="checkRow"><input type="checkbox" name="enabled" value="1" ${job.enabled?'checked':''}> Enabled</label></div><button class="button secondary btn-sm">Save schedule</button></form>
            <form method="post" action="/admin/automation/${encodeURIComponent(job.job_key)}/run">${token(req)}<button class="button btn-sm">Run now${job.enabled?'':' once'}</button></form></article>`;
    }).join('');
    const states=jobs.map(job=>jobHealth.healthState(job));
    const unhealthy=states.filter(state=>['failed','stale','missing'].includes(state)).length;
    const disabled=states.filter(state=>state==='disabled').length;
    const healthy=states.filter(state=>state==='healthy').length;
    const workerAlive=Boolean(worker&&Number(worker.heartbeat_age_seconds)<=Math.max(60,Math.ceil(Number(worker?.metadata?.pollMs||15000)/1000)*4));
    const workerBanner=worker?`<div class="statusBanner"><strong>Automation worker:</strong> ${workerAlive?'<span class="pill good">alive</span>':'<span class="pill bad">stale</span>'} · instance ${esc(worker.instance_id)} · version ${esc(worker.version||'unknown')} · heartbeat ${esc(worker.heartbeat_age_seconds)}s ago${worker.draining_at?` · draining since ${esc(dt(worker.draining_at))}`:''}.</div>`:'<div class="notice error"><strong>Automation worker heartbeat missing.</strong> The job configuration exists, but no current worker has registered itself.</div>';
    return layout({siteName:runtimeSettings.siteName(),active:'automation-jobs',title:'Automation',subtitle:'Schedules, singleton locks and live worker health',body:`${notice(req)}<div class="metrics"><div class="metric"><div class="metricLabel">Jobs</div><div class="metricValue">${jobs.length}</div></div><div class="metric"><div class="metricLabel">Healthy</div><div class="metricValue">${healthy}</div></div><div class="metric"><div class="metricLabel">Needs attention</div><div class="metricValue">${unhealthy}</div></div><div class="metric"><div class="metricLabel">Disabled</div><div class="metricValue">${disabled}</div></div></div>${workerBanner}<div class="serverGrid">${cards}</div>`});
}

function createAdminAutomationRouter(){
    const router=express.Router();
    router.use('/admin/automation',gate,noStore);
    router.get('/admin/automation',async(req,res,next)=>{try{return res.send(await page(req));}catch(error){next(error);}});
    router.post('/admin/automation/:job',async(req,res)=>{
        if(!csrf.verify(req))return res.status(403).send('Invalid security token');
        try{await jobHealth.update(req.params.job,{enabled:req.body.enabled==='1',intervalSeconds:req.body.intervalSeconds});return res.redirect('/admin/automation?message='+encodeURIComponent('Automation schedule saved.'));}
        catch(error){return res.redirect('/admin/automation?error='+encodeURIComponent(error.message));}
    });
    router.post('/admin/automation/:job/run',async(req,res)=>{
        if(!csrf.verify(req))return res.status(403).send('Invalid security token');
        try{const job=await jobHealth.requestRun(req.params.job);return res.redirect('/admin/automation?message='+encodeURIComponent(job.enabled?'Job queued to run on the next worker poll.':'One-time forced run queued; the recurring schedule remains disabled.'));}
        catch(error){return res.redirect('/admin/automation?error='+encodeURIComponent(error.message));}
    });
    return router;
}

module.exports={createAdminAutomationRouter,page,LABELS,workerState};
