'use strict';
const express=require('express');
const {query}=require('../db');
const csrf=require('../auth/csrf');
const runtimeSettings=require('./runtime-settings');
const {esc,layout}=require('./admin-html');
const customerFilters=require('./customer-filters');
const bulkJobs=require('./bulk-jobs');

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired')}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next()}
function t(v,max=200){return String(v||'').trim().slice(0,max)}

// key, label, { highImpact, fields }. High-impact actions always require a
// preview and literal CONFIRM before a background job can be created.
const BULK_ACTIONS=[
    ['library_add','Libraries: Add',{highImpact:false,fields:['libraryNames']}],
    ['library_remove','Libraries: Remove',{highImpact:false,fields:['libraryNames']}],
    ['library_replace','Libraries: Replace',{highImpact:true,fields:['libraryNames']}],
    ['library_reset','Libraries: Reset to plan',{highImpact:false,fields:[]}],
    ['plan_change','Change plan',{highImpact:true,fields:['planId']}],
    ['extend_entitlement','Extend entitlement',{highImpact:false,fields:['units']}],
    ['set_expiry','Set expiry date',{highImpact:true,fields:['expiryDate']}],
    ['reset_overrides','Reset admin overrides to plan',{highImpact:false,fields:[]}],
    ['enable','Enable / reactivate service access',{highImpact:false,fields:[]}],
    ['disable','Disable service access',{highImpact:true,fields:[]}],
    ['suspend','Suspend service access',{highImpact:true,fields:[]}],
    ['ban','Ban: registration + service access',{highImpact:true,fields:['reason']}],
    ['jellyfin_delete','Delete Jellyfin account(s)',{highImpact:true,fields:['reason']}],
    ['migrate_server','Migrate to another Jellyfin server',{highImpact:true,fields:['serverId']}],
    ['reconcile','Reconcile Jellyfin policy',{highImpact:false,fields:[]}],
    ['retry_failed','Retry failed provisioning',{highImpact:false,fields:[]}],
    ['revoke_sessions','Force logout / revoke sessions',{highImpact:false,fields:[]}],
    ['reseller_assign','Assign reseller',{highImpact:true,fields:['resellerId']}],
    ['reseller_detach','Detach from reseller',{highImpact:true,fields:[]}],
    ['payments_sync','Sync payment state',{highImpact:false,fields:[]}]
];
const ACTION_MAP=new Map(BULK_ACTIONS.map(([key,label,meta])=>[key,{label,...meta}]));

function parseSelectionInput(body){
    const customerIds=Array.isArray(body.customerId)?body.customerId:(body.customerId!==undefined?[body.customerId]:[]);
    return {selectAllMatching:body.selectAllMatching==='1',customerIds,filters:require('./admin-customers-list').parseFilters(body)};
}

async function resolveSelection(selection,scope){
    if(selection.selectAllMatching)return customerFilters.matchingCustomerIds(selection.filters,scope);
    return customerFilters.reauthorizeCustomerIds(selection.customerIds,scope);
}

function unsafeReason(action,row){
    if(['extend_entitlement','set_expiry','library_add','library_remove','library_replace','library_reset','reconcile','migrate_server'].includes(action)&&!row.plan_id)return 'No active plan';
    if(action==='jellyfin_delete'&&!Number(row.account_count||0))return 'No Jellyfin account';
    return null;
}

async function selectionSummary(customerIds,action){
    if(!customerIds.length)return {rows:[],safe:[],unsafe:[],serverBreakdown:[],planBreakdown:[]};
    const result=await query(`
        SELECT c.id,COALESCE(c.display_name,au.username,c.email,'Customer') AS name,
               COALESCE(c.email,au.email) AS email,cur.plan_id,p.name AS plan_name,
               (SELECT COUNT(*)::int FROM jellyfin_accounts ja2 WHERE ja2.customer_id=c.id) AS account_count,
               (SELECT ARRAY_AGG(DISTINCT js.name) FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id WHERE ja.customer_id=c.id) AS server_names
        FROM customers c
        LEFT JOIN app_users au ON au.id=c.user_id
        LEFT JOIN LATERAL (SELECT s.* FROM subscriptions s WHERE s.customer_id=c.id ORDER BY s.current_period_end DESC,s.created_at DESC LIMIT 1) cur ON TRUE
        LEFT JOIN plans p ON p.id=cur.plan_id
        WHERE c.id=ANY($1::uuid[])
    `,[customerIds]);
    const rows=result.rows,safe=[],unsafe=[],planCounts=new Map(),serverCounts=new Map();
    for(const row of rows){
        const reason=unsafeReason(action,row);if(reason)unsafe.push({...row,reason});else safe.push(row);
        planCounts.set(row.plan_name||'No plan',(planCounts.get(row.plan_name||'No plan')||0)+1);
        for(const s of (row.server_names||[]))serverCounts.set(s,(serverCounts.get(s)||0)+1);
    }
    return {rows,safe,unsafe,planBreakdown:Array.from(planCounts.entries()),serverBreakdown:Array.from(serverCounts.entries())};
}

function fieldForm(action){
    const meta=ACTION_MAP.get(action);if(!meta)return '';
    return meta.fields.map(field=>{
        if(field==='libraryNames')return `<div class="formGroup"><label>Library names <span class="muted">(one per line)</span></label><textarea class="input" name="libraryNames" rows="4" required></textarea></div>`;
        if(field==='planId')return `<div class="formGroup"><label>Target plan ID</label><input class="input" name="planId" required placeholder="Use the plan UUID from Plans"></div>`;
        if(field==='units')return `<div class="formGroup"><label>Extend by (units of the current plan duration)</label><input class="input" type="number" name="units" min="1" max="24" value="1" required></div>`;
        if(field==='expiryDate')return `<div class="formGroup"><label>New expiry date</label><input class="input" type="date" name="expiryDate" required></div>`;
        if(field==='resellerId')return `<div class="formGroup"><label>Target reseller ID</label><input class="input" name="resellerId" required placeholder="Use the reseller UUID from Resellers"></div>`;
        if(field==='serverId')return `<div class="formGroup"><label>Target Jellyfin server ID</label><input class="input" name="serverId" required placeholder="Use the server UUID from Servers"><div class="muted">Each customer is re-validated against plan, library, health and capacity rules before moving.</div></div>`;
        if(field==='reason')return `<div class="formGroup"><label>Operator reason</label><input class="input" name="reason" maxlength="500" required placeholder="Why is this action required?"></div>`;
        return '';
    }).join('');
}

function previewPage(req,action,selection,summary,idempotencyKey){
    const meta=ACTION_MAP.get(action),{filterHiddenFields}=require('./admin-customers-list');
    const selectionHidden=selection.selectAllMatching?`<input type="hidden" name="selectAllMatching" value="1">${filterHiddenFields(selection.filters)}`:selection.customerIds.map(id=>`<input type="hidden" name="customerId" value="${esc(id)}">`).join('');
    const body=`<section class="section"><div class="sectionHead"><h2>Preview: ${esc(meta.label)}</h2><span class="muted">${summary.safe.length} will be processed${summary.unsafe.length?`, ${summary.unsafe.length} cannot be processed`:''}</span></div>
    ${meta.highImpact?'<div class="notice error"><strong>High-impact action.</strong> Portal identity is preserved unless an administrator separately disables the portal account. Review every affected customer before confirming.</div>':''}
    <div class="metrics"><div class="metric"><div class="metricLabel">Affected</div><div class="metricValue">${summary.safe.length}</div></div><div class="metric"><div class="metricLabel">Cannot process</div><div class="metricValue">${summary.unsafe.length}</div></div></div>
    ${summary.planBreakdown.length?`<div class="section"><h3>By plan</h3>${summary.planBreakdown.map(([name,n])=>`<span class="pill">${esc(name)}: ${n}</span>`).join(' ')}</div>`:''}
    ${summary.serverBreakdown.length?`<div class="section"><h3>By server</h3>${summary.serverBreakdown.map(([name,n])=>`<span class="pill">${esc(name)}: ${n}</span>`).join(' ')}</div>`:''}
    ${summary.unsafe.length?`<div class="section"><h3>Cannot process (excluded)</h3><div class="tableWrap"><table class="dataTable"><thead><tr><th>Customer</th><th>Reason</th></tr></thead><tbody>${summary.unsafe.slice(0,50).map(x=>`<tr><td>${esc(x.name)}</td><td>${esc(x.reason)}</td></tr>`).join('')}</tbody></table></div></div>`:''}
    <form class="formPanel" method="post" action="/admin/customers/bulk/confirm"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><input type="hidden" name="action" value="${esc(action)}"><input type="hidden" name="idempotencyKey" value="${esc(idempotencyKey)}">${selectionHidden}${fieldForm(action)}${meta.highImpact?`<div class="formGroup"><label>Type CONFIRM to proceed</label><input class="input" name="confirmWord" autocomplete="off" required></div>`:''}<div class="buttonRow"><button class="button ${meta.highImpact?'btn-danger':''}">Confirm and run</button><a class="button secondary" href="/admin/users">Cancel</a></div></form></section>`;
    return layout({siteName:runtimeSettings.siteName(),active:'users',title:'Bulk action preview',subtitle:meta.label,body});
}

function createAdminBulkCustomersRouter(){
    const r=express.Router();r.use('/admin/customers/bulk',gate,noStore);
    r.post('/admin/customers/bulk/preview',async(req,res,next)=>{
        if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
        try{await runtimeSettings.ensureLoaded();const action=t(req.body.action,40);if(!ACTION_MAP.has(action))return res.redirect('/admin/users?error='+encodeURIComponent('Choose a valid bulk action.'));const selection=parseSelectionInput(req.body),ids=await resolveSelection(selection,null);if(!ids.length)return res.redirect('/admin/users?error='+encodeURIComponent('No customers matched your selection.'));const summary=await selectionSummary(ids,action),idempotencyKey=bulkJobs.newIdempotencyKey();return res.send(previewPage(req,action,selection,summary,idempotencyKey));}catch(error){return next(error)}
    });
    r.post('/admin/customers/bulk/confirm',async(req,res)=>{
        if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
        try{
            const action=t(req.body.action,40),meta=ACTION_MAP.get(action);if(!meta)throw new Error('validation');if(meta.highImpact&&String(req.body.confirmWord||'').trim()!=='CONFIRM')throw new Error('confirm_word');
            const selection=parseSelectionInput(req.body),ids=await resolveSelection(selection,null);if(!ids.length)throw new Error('empty');const summary=await selectionSummary(ids,action),params={};
            if(meta.fields.includes('libraryNames'))params.libraryNames=String(req.body.libraryNames||'').split('\n').map(x=>x.trim()).filter(Boolean).slice(0,200);
            if(meta.fields.includes('planId')){params.planId=t(req.body.planId,60);const c=await query('SELECT 1 FROM plans WHERE id=$1 AND active=TRUE',[params.planId]);if(!c.rowCount)throw new Error('validation')}
            if(meta.fields.includes('units')){const n=Number.parseInt(req.body.units,10);if(!Number.isInteger(n)||n<1||n>24)throw new Error('validation');params.units=n}
            if(meta.fields.includes('expiryDate')){if(!/^\d{4}-\d{2}-\d{2}$/.test(String(req.body.expiryDate||'')))throw new Error('validation');params.expiryDate=req.body.expiryDate}
            if(meta.fields.includes('resellerId')){params.resellerId=t(req.body.resellerId,60);const c=await query('SELECT 1 FROM resellers WHERE id=$1',[params.resellerId]);if(!c.rowCount)throw new Error('validation')}
            if(meta.fields.includes('serverId')){params.serverId=t(req.body.serverId,60);const c=await query('SELECT 1 FROM jellyfin_servers WHERE id=$1 AND enabled=TRUE',[params.serverId]);if(!c.rowCount)throw new Error('validation')}
            if(meta.fields.includes('reason')){params.reason=t(req.body.reason,500);if(params.reason.length<3)throw new Error('validation')}
            const {job,reused}=await bulkJobs.createJob(action,params,{createdBy:req.session.authUserId,idempotencyKey:t(req.body.idempotencyKey,80)||null});
            if(!reused)await bulkJobs.enqueueItems(job.id,summary.safe.map(x=>x.id));
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.bulk.'||$2,'background_job',$3,$4::jsonb)`,[req.session.authUserId,action,job.id,JSON.stringify({affected:summary.safe.length,excluded:summary.unsafe.length,params})]);
            return res.redirect(`/admin/jobs/${encodeURIComponent(job.id)}?message=`+encodeURIComponent(reused?'This bulk action was already submitted.':'Bulk action queued.'));
        }catch(error){const message=error.message==='confirm_word'?'Type CONFIRM exactly to proceed with a high-impact action.':error.message==='empty'?'No customers matched your selection.':'Bulk action could not be started safely.';return res.redirect('/admin/users?error='+encodeURIComponent(message));}
    });
    return r;
}
module.exports={createAdminBulkCustomersRouter,BULK_ACTIONS,ACTION_MAP};
