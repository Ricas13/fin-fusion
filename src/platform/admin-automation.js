'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const jobHealth = require('../automation/job-health');
const { layout, esc } = require('./admin-html');
const runtimeSettings = require('./runtime-settings');

const LABELS = {
    health: ['Jellyfin health', 'Checks configured servers and updates health status.'],
    entitlements: ['Entitlements', 'Expires due subscriptions and reconciles active customer access.'],
    bulk_jobs: ['Bulk operations', 'Processes queued bulk customer actions.'],
    stale_reclaim: ['Stale job reclaim', 'Recovers abandoned running bulk items safely.'],
    email_outbox: ['Transactional email', 'Delivers due messages from the encrypted outbox.'],
    request_users: ['Request users', 'Synchronises CAPTaINFiN customer access to Seerr/Overseerr.'],
    billing: ['Customer billing', 'Re-verifies recurring direct-customer provider subscriptions.'],
    reseller_billing: ['Reseller billing', 'Re-verifies Stripe/PayPal reseller subscriptions.'],
    reseller_estates: ['Reseller estates', 'Applies parent reseller entitlement changes to child customers.']
};

function gate(req,res,next){ return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId ? next() : res.redirect('/login?session=expired'); }
function noStore(_req,res,next){ res.setHeader('Cache-Control','no-store, private, max-age=0'); res.setHeader('Pragma','no-cache'); next(); }
function dt(value){ return value ? new Date(value).toLocaleString('en-GB') : 'Never'; }
function duration(value){ return value==null ? '—' : Number(value)<1000 ? `${value} ms` : `${(Number(value)/1000).toFixed(1)} s`; }
function intervalLabel(seconds){ const n=Number(seconds||0); if(n%3600===0)return `${n/3600}h`; if(n%60===0)return `${n/60}m`; return `${n}s`; }
function notice(req){ return `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`; }
function token(req){ return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`; }

async function page(req) {
    await runtimeSettings.ensureLoaded();
    const jobs = await jobHealth.list();
    const cards = jobs.map(job => {
        const [name,description] = LABELS[job.job_key] || [job.job_key,'Background platform task'];
        const healthy = !job.last_error;
        return `<article class="serverCard"><div class="serverTop"><div><strong>${esc(name)}</strong><div class="subText">${esc(description)}</div></div><span class="pill ${job.enabled?(healthy?'good':'bad'):'warn'}">${job.enabled?(healthy?'Enabled':'Error'):'Disabled'}</span></div>
            <div class="serverStats"><div><span class="metricMini">${esc(intervalLabel(job.interval_seconds))}</span><span class="subText">interval</span></div><div><span class="metricMini">${esc(job.last_processed_count==null?'—':job.last_processed_count)}</span><span class="subText">last processed</span></div><div><span class="metricMini">${esc(job.consecutive_failures||0)}</span><span class="subText">failures</span></div></div>
            <div class="kvList"><div class="kvRow"><div class="kvLabel">Last start</div><div class="kvValue">${esc(dt(job.last_started_at))}</div></div><div class="kvRow"><div class="kvLabel">Last success</div><div class="kvValue">${esc(dt(job.last_success_at))}</div></div><div class="kvRow"><div class="kvLabel">Duration</div><div class="kvValue">${esc(duration(job.last_duration_ms))}</div></div><div class="kvRow"><div class="kvLabel">Next run</div><div class="kvValue">${esc(dt(job.next_run_at))}</div></div></div>
            ${job.last_error?`<div class="notice error"><strong>Last error:</strong> ${esc(job.last_error)}</div>`:''}
            <form class="formPanel" method="post" action="/admin/automation/${encodeURIComponent(job.job_key)}"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><div class="formGrid"><div class="formGroup"><label>Interval seconds</label><input class="input" type="number" min="30" max="86400" name="intervalSeconds" value="${esc(job.interval_seconds)}"></div><label class="checkRow"><input type="checkbox" name="enabled" value="1" ${job.enabled?'checked':''}> Enabled</label></div><button class="button secondary btn-sm">Save schedule</button></form>
            <form method="post" action="/admin/automation/${encodeURIComponent(job.job_key)}/run">${token(req)}<button class="button btn-sm">Run now</button></form></article>`;
    }).join('');
    const unhealthy=jobs.filter(job=>job.last_error).length;
    const disabled=jobs.filter(job=>!job.enabled).length;
    return layout({siteName:runtimeSettings.siteName(),active:'automation-jobs',title:'Automation',subtitle:'Schedules, singleton locks and job health',body:`${notice(req)}<div class="metrics"><div class="metric"><div class="metricLabel">Jobs</div><div class="metricValue">${jobs.length}</div></div><div class="metric"><div class="metricLabel">Healthy</div><div class="metricValue">${jobs.length-unhealthy-disabled}</div></div><div class="metric"><div class="metricLabel">Errors</div><div class="metricValue">${unhealthy}</div></div><div class="metric"><div class="metricLabel">Disabled</div><div class="metricValue">${disabled}</div></div></div><div class="statusBanner"><strong>Dedicated worker:</strong> these schedules are executed by the automation-worker service. PostgreSQL advisory locks prevent the same singleton job running concurrently across replicas.</div><div class="serverGrid">${cards}</div>`});
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
        try{await jobHealth.requestRun(req.params.job);return res.redirect('/admin/automation?message='+encodeURIComponent('Job queued to run on the next worker poll.'));}
        catch(error){return res.redirect('/admin/automation?error='+encodeURIComponent(error.message));}
    });
    return router;
}

module.exports={createAdminAutomationRouter,page,LABELS};
