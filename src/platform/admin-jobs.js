'use strict';
const express=require('express');
const csrf=require('../auth/csrf');
const bulkJobs=require('./bulk-jobs');
const {esc,layout}=require('./admin-html');

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired')}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next()}
function site(){return process.env.SITE_NAME||'CAPTAiNFiN'}
function pill(v,k=''){return `<span class="pill ${k}">${esc(v)}</span>`}
function dt(v){return v?new Date(v).toLocaleString():'—'}

const STATUS_KIND={pending:'',running:'warn',succeeded:'good',failed:'bad',skipped:''};
const JOB_LABELS={plan_reconcile:'Plan Jellyfin policy reconciliation'};

function jobLabel(job){return JOB_LABELS[job.job_type]||job.job_type}

async function page(req,job){
    const counts=await bulkJobs.jobCounts(job.id);
    const items=await bulkJobs.listJobItems(job.id,{limit:500});
    const total=job.total_items||0;
    const done=counts.succeeded+counts.failed+counts.skipped;
    const rows=items.map(item=>`<tr><td data-label="Customer">${esc(item.customer_name||item.customer_id)}</td><td data-label="Status">${pill(item.status,STATUS_KIND[item.status]||'')}</td><td data-label="Attempts">${esc(item.attempt_count)}</td><td data-label="Error">${esc(item.last_error||'—')}</td></tr>`).join('');
    const body=`<section class="section"><div class="sectionHead"><h2>${esc(jobLabel(job))}</h2><span class="muted">${pill(job.status,job.status==='completed'?'good':job.status==='failed'||job.status==='completed_with_errors'?'bad':'warn')}</span></div><div class="metrics"><div class="metric"><div class="metricLabel">Progress</div><div class="metricValue small">${done} / ${total}</div></div><div class="metric"><div class="metricLabel">Succeeded</div><div class="metricValue small">${counts.succeeded}</div></div><div class="metric"><div class="metricLabel">Failed</div><div class="metricValue small">${counts.failed}</div></div><div class="metric"><div class="metricLabel">Pending</div><div class="metricValue small">${counts.pending+counts.running}</div></div></div>${counts.failed?`<form class="formPanel compactAction" method="post" action="/admin/jobs/${esc(job.id)}/retry"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><button class="button secondary">Retry failed items</button></form>`:''}<div class="muted" style="margin:10px 0">Created ${esc(dt(job.created_at))}${job.completed_at?` · Completed ${esc(dt(job.completed_at))}`:''}. This page refreshes progress on reload.</div>${items.length?`<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Customer</th><th>Status</th><th>Attempts</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table></div>`:'<div class="empty">No items in this job.</div>'}</section>`;
    return layout({siteName:site(),active:'users',title:'Background job',subtitle:jobLabel(job),body});
}

function createAdminJobsRouter(){
    const r=express.Router();
    r.use('/admin/jobs',gate,noStore);
    r.get('/admin/jobs/:id',async(req,res,next)=>{try{const job=await bulkJobs.getJob(req.params.id);if(!job)return res.status(404).send('Job not found');return res.send(await page(req,job))}catch(e){next(e)}});
    r.post('/admin/jobs/:id/retry',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await bulkJobs.retryFailedItems(req.params.id,null);return res.redirect(`/admin/jobs/${encodeURIComponent(req.params.id)}?message=`+encodeURIComponent('Failed items queued for retry.'))}catch(e){return res.status(404).send('Job not found')}});
    return r;
}
module.exports={createAdminJobsRouter};
