'use strict';
const express=require('express');
const {query}=require('../db');
const {esc,layout}=require('./admin-html');
const csrf=require('../auth/csrf');
const customerFilters=require('./customer-filters');
const registry=require('../jellyfin/registry');
const {sendCsv}=require('./export');
const {BULK_ACTIONS}=require('./admin-bulk-customers');
const graphics=require('./admin-section-graphics');

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired')}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next()}
function site(){return process.env.SITE_NAME||'CAPTAiNFiN'}
function t(v,max=200){return String(v||'').trim().slice(0,max)}
function pill(v,k=''){return `<span class="pill ${k}">${esc(v)}</span>`}
function date(v){return v?new Date(v).toLocaleDateString():'—'}
function dt(v){return v?new Date(v).toLocaleString():'—'}
function notice(req){return `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`}

function parseFilters(q){
    const f={};
    if(q.q)f.q=t(q.q,80);
    if(q.server&&customerFilters.isUuid(q.server))f.serverId=q.server;
    if(q.plan&&customerFilters.isUuid(q.plan))f.planId=q.plan;
    if(customerFilters.STATUS_VALUES.includes(q.status)||q.status==='none')f.status=q.status;
    if(['enabled','disabled','portal_disabled'].includes(q.accountStatus))f.accountStatus=q.accountStatus;
    if(customerFilters.PAYMENT_PROVIDERS.includes(q.paymentProvider)||q.paymentProvider==='none')f.paymentProvider=q.paymentProvider;
    if(q.expiryFrom)f.expiryFrom=t(q.expiryFrom,32);
    if(q.expiryTo)f.expiryTo=t(q.expiryTo,32);
    if(q.lastActiveFrom)f.lastActiveFrom=t(q.lastActiveFrom,32);
    if(q.lastActiveTo)f.lastActiveTo=t(q.lastActiveTo,32);
    if(q.registeredFrom)f.registeredFrom=t(q.registeredFrom,32);
    if(q.registeredTo)f.registeredTo=t(q.registeredTo,32);
    if(customerFilters.RECON_VALUES.includes(q.reconciliationStatus)||q.reconciliationStatus==='none')f.reconciliationStatus=q.reconciliationStatus;
    if(q.hasOverride==='1')f.hasOverride=true; else if(q.hasOverride==='0')f.hasOverride=false;
    if(q.library)f.library=t(q.library,200);
    return f;
}

function filterHiddenFields(filters){
    const map={q:filters.q,server:filters.serverId,plan:filters.planId,status:filters.status,accountStatus:filters.accountStatus,paymentProvider:filters.paymentProvider,expiryFrom:filters.expiryFrom,expiryTo:filters.expiryTo,lastActiveFrom:filters.lastActiveFrom,lastActiveTo:filters.lastActiveTo,registeredFrom:filters.registeredFrom,registeredTo:filters.registeredTo,reconciliationStatus:filters.reconciliationStatus,library:filters.library};
    if(filters.hasOverride===true)map.hasOverride='1'; else if(filters.hasOverride===false)map.hasOverride='0';
    return Object.entries(map).filter(([,v])=>v!==undefined&&v!==null&&v!=='').map(([k,v])=>`<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
}

function queryStringFor(filters,extra={}){
    const params=new URLSearchParams();
    const map={q:filters.q,server:filters.serverId,plan:filters.planId,status:filters.status,accountStatus:filters.accountStatus,paymentProvider:filters.paymentProvider,expiryFrom:filters.expiryFrom,expiryTo:filters.expiryTo,lastActiveFrom:filters.lastActiveFrom,lastActiveTo:filters.lastActiveTo,registeredFrom:filters.registeredFrom,registeredTo:filters.registeredTo,reconciliationStatus:filters.reconciliationStatus,library:filters.library};
    if(filters.hasOverride===true)map.hasOverride='1'; else if(filters.hasOverride===false)map.hasOverride='0';
    for(const [k,v] of Object.entries(map))if(v!==undefined&&v!==null&&v!=='')params.set(k,v);
    for(const [k,v] of Object.entries(extra))if(v!==undefined&&v!==null&&v!=='')params.set(k,v);
    return params.toString();
}

async function filterOptions(){
    const [servers,plans]=await Promise.all([
        registry.listServers({enabledOnly:false}),
        query('SELECT id,name FROM plans ORDER BY sort_order,name'),
    ]);
    return {servers,plans:plans.rows};
}

function optionList(items,current){return items.map(x=>`<option value="${esc(x.id)}" ${String(x.id)===String(current)?'selected':''}>${esc(x.name)}</option>`).join('')}

function filterForm(filters,options){
    return `<form class="formPanel filterForm" method="get" action="/admin/users"><div class="formGrid">
        <div class="formGroup"><label>Search</label><input class="input" name="q" value="${esc(filters.q||'')}" placeholder="Name, email, username"></div>
        <div class="formGroup"><label>Server</label><select class="input" name="server"><option value="">Any</option>${optionList(options.servers,filters.serverId)}</select></div>
        <div class="formGroup"><label>Plan</label><select class="input" name="plan"><option value="">Any</option>${optionList(options.plans,filters.planId)}</select></div>
        <div class="formGroup"><label>Subscription status</label><select class="input" name="status"><option value="">Any</option><option value="none" ${filters.status==='none'?'selected':''}>No subscription</option>${customerFilters.STATUS_VALUES.map(s=>`<option value="${esc(s)}" ${filters.status===s?'selected':''}>${esc(s)}</option>`).join('')}</select></div>
        <div class="formGroup"><label>Account status</label><select class="input" name="accountStatus"><option value="">Any</option><option value="enabled" ${filters.accountStatus==='enabled'?'selected':''}>Jellyfin enabled</option><option value="disabled" ${filters.accountStatus==='disabled'?'selected':''}>Jellyfin disabled</option><option value="portal_disabled" ${filters.accountStatus==='portal_disabled'?'selected':''}>Portal disabled</option></select></div>
        <div class="formGroup"><label>Payment provider</label><select class="input" name="paymentProvider"><option value="">Any</option><option value="none" ${filters.paymentProvider==='none'?'selected':''}>None</option>${customerFilters.PAYMENT_PROVIDERS.map(pr=>`<option value="${esc(pr)}" ${filters.paymentProvider===pr?'selected':''}>${esc(pr)}</option>`).join('')}</select></div>
        <div class="formGroup"><label>Reconciliation status</label><select class="input" name="reconciliationStatus"><option value="">Any</option><option value="none" ${filters.reconciliationStatus==='none'?'selected':''}>No accounts</option>${customerFilters.RECON_VALUES.map(s=>`<option value="${esc(s)}" ${filters.reconciliationStatus===s?'selected':''}>${esc(s)}</option>`).join('')}</select></div>
        <div class="formGroup"><label>Admin override</label><select class="input" name="hasOverride"><option value="">Any</option><option value="1" ${filters.hasOverride===true?'selected':''}>Has override</option><option value="0" ${filters.hasOverride===false?'selected':''}>No override</option></select></div>
        <div class="formGroup"><label>Library</label><input class="input" name="library" value="${esc(filters.library||'')}" placeholder="Library name"></div>
        <div class="formGroup"><label>Expiry from</label><input class="input" type="date" name="expiryFrom" value="${esc(filters.expiryFrom||'')}"></div>
        <div class="formGroup"><label>Expiry to</label><input class="input" type="date" name="expiryTo" value="${esc(filters.expiryTo||'')}"></div>
        <div class="formGroup"><label>Last active from</label><input class="input" type="date" name="lastActiveFrom" value="${esc(filters.lastActiveFrom||'')}"></div>
        <div class="formGroup"><label>Last active to</label><input class="input" type="date" name="lastActiveTo" value="${esc(filters.lastActiveTo||'')}"></div>
        <div class="formGroup"><label>Registered from</label><input class="input" type="date" name="registeredFrom" value="${esc(filters.registeredFrom||'')}"></div>
        <div class="formGroup"><label>Registered to</label><input class="input" type="date" name="registeredTo" value="${esc(filters.registeredTo||'')}"></div>
        </div><div class="buttonRow"><button class="button">Apply filters</button><a class="button secondary" href="/admin/users">Clear</a></div></form>`;
}

function row(x){
    const statusKind=x.subscription_status==='active'||x.subscription_status==='trialing'?'good':x.subscription_status?'warn':'';
    const reconLabel=x.recon_rank?{1:'failed',2:'pending',3:'running',4:'successful'}[x.recon_rank]:null;
    return `<tr>
        <td data-label=""><input type="checkbox" class="rowCheck" form="bulkForm" name="customerId" value="${esc(x.id)}"></td>
        <td data-label="Customer"><a class="mediaTitle" href="/admin/users/${esc(x.id)}">${esc(x.display_name||x.login_username||'Customer')}</a><div class="subText">${esc(x.email||x.login_username||'')}</div></td>
        <td data-label="Plan">${esc(x.plan_name||'No plan')}</td>
        <td data-label="Status">${pill(x.subscription_status||'none',statusKind)}</td>
        <td data-label="Expires">${esc(date(x.current_period_end))}</td>
        <td data-label="Jellyfin">${esc(x.account_count||0)}${x.has_enabled_account===false&&x.account_count?' (disabled)':''}</td>
        <td data-label="Server">${x.server_names?esc(x.server_names):'—'}</td>
        <td data-label="Reconciliation">${reconLabel?pill(reconLabel,reconLabel==='failed'?'bad':reconLabel==='successful'?'good':'warn'):'—'}</td>
        <td data-label="Override">${x.has_override?pill('Yes','accent'):'—'}</td>
        <td data-label="Last active">${esc(dt(x.last_activity_at))}</td>
    </tr>`;
}

function pagination(filters,page,pageSize,total){
    const pages=Math.max(Math.ceil(total/pageSize),1);
    if(pages<=1)return '';
    const links=[];
    if(page>1)links.push(`<a class="button secondary btn-sm" href="/admin/users?${queryStringFor(filters,{page:page-1})}">Previous</a>`);
    links.push(`<span class="muted">Page ${page} of ${pages}</span>`);
    if(page<pages)links.push(`<a class="button secondary btn-sm" href="/admin/users?${queryStringFor(filters,{page:page+1})}">Next</a>`);
    return `<div class="buttonRow">${links.join('')}</div>`;
}

function bulkBar(req,filters,total){
    return `<section class="section bulkBar"><div class="sectionHead"><h2>Bulk actions</h2><span class="muted">${total} matching this filter</span></div>
        <form method="post" action="/admin/customers/bulk/preview" id="bulkForm" data-native-submit="true">
        <input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">
        ${filterHiddenFields(filters)}
        <div class="formGrid">
            <div class="formGroup"><label>Action</label><select class="input" name="action" required><option value="">Choose an action</option>${BULK_ACTIONS.map(([key,label])=>`<option value="${esc(key)}">${esc(label)}</option>`).join('')}</select></div>
            <div class="formGroup"><label><input type="checkbox" name="selectAllMatching" value="1"> Select all ${total} matching results (not just this page)</label></div>
        </div>
        <div class="muted" style="margin:6px 0 10px">Or check individual rows in the table above, then choose an action.</div>
        <div class="buttonRow"><button class="button">Continue</button></div>
        </form></section>`;
}

async function customerOverview(){
    const [summary,plans]=await Promise.all([
        query(`SELECT
            (SELECT COUNT(*)::int FROM customers) total,
            (SELECT COUNT(*)::int FROM app_users u JOIN customers c ON c.user_id=u.id WHERE u.active=TRUE) portal_enabled,
            (SELECT COUNT(DISTINCT customer_id)::int FROM subscriptions WHERE superseded_by IS NULL AND status IN('active','trialing') AND current_period_end>NOW()) active_access,
            (SELECT COUNT(DISTINCT customer_id)::int FROM subscriptions WHERE superseded_by IS NULL AND status='past_due') past_due,
            (SELECT COUNT(*)::int FROM customers WHERE created_at>=NOW()-INTERVAL '30 days') new_30d,
            (SELECT COUNT(DISTINCT customer_id)::int FROM playback_history WHERE customer_id IS NOT NULL AND started_at>=NOW()-INTERVAL '30 days') active_30d,
            (SELECT COUNT(DISTINCT customer_id)::int FROM jellyfin_accounts WHERE disabled=FALSE) jellyfin_ready,
            (SELECT COUNT(*)::int FROM jellyfin_accounts WHERE disabled=TRUE) disabled_accounts,
            (SELECT COUNT(*)::int FROM customer_provisioning_state WHERE status IN('blocked','failed')) provisioning_attention,
            (SELECT COUNT(DISTINCT c.id)::int FROM customers c JOIN app_users u ON u.id=c.user_id WHERE u.email_verified_at IS NULL) unverified`).catch(()=>({rows:[{}]})),
        query(`SELECT COALESCE(p.name,'No active plan') name,COUNT(DISTINCT c.id)::int count
            FROM customers c
            LEFT JOIN subscriptions s ON s.customer_id=c.id AND s.superseded_by IS NULL AND s.status IN('active','trialing') AND s.current_period_end>NOW()
            LEFT JOIN plans p ON p.id=s.plan_id
            GROUP BY 1 ORDER BY count DESC,name LIMIT 6`).catch(()=>({rows:[]}))
    ]);
    return{summary:summary.rows[0]||{},plans:plans.rows};
}
function customerOverviewHtml(data){
    const s=data.summary,total=Number(s.total||0),ready=Number(s.jellyfin_ready||0),active=Number(s.active_access||0),attention=Number(s.provisioning_attention||0)+Number(s.disabled_accounts||0)+Number(s.past_due||0);
    return `${graphics.hero({title:'People health',subtitle:'Customer growth, active entitlement, Jellyfin readiness and support pressure in one view.',tone:attention?'warn':'good',stats:[
        graphics.stat({label:'Customers',value:graphics.number(total),meta:`${graphics.number(s.new_30d)} joined in 30 days`,tone:'blue',href:'/admin/users?sort=recent'}),
        graphics.stat({label:'Active access',value:graphics.number(active),meta:`${graphics.number(s.portal_enabled)} portal logins enabled`,tone:'good'}),
        graphics.stat({label:'Recently active',value:graphics.number(s.active_30d),meta:'played in the last 30 days',tone:'violet'}),
        graphics.stat({label:'Needs attention',value:graphics.number(attention),meta:'past due, disabled or provisioning blocked',tone:attention?'warn':'good',href:'/admin/attention'})
    ],meters:[graphics.meter({label:'Jellyfin readiness',value:ready,max:Math.max(total,ready),tone:ready>=total?'good':'blue',meta:`${graphics.number(ready)} customer(s) have enabled Jellyfin access`})],actions:'<a class="button secondary" href="/admin/users/new">Add customer</a><a class="button secondary" href="/admin/jellyfin-import">Import Jellyfin users</a>'})}${graphics.insightGrid([
        {title:'Plan mix',subtitle:'Current active and trialing customers',value:graphics.number(active),body:graphics.bars(data.plans),tone:'blue',href:'/admin/plans',linkLabel:'Open plans'},
        {title:'Activation',subtitle:'Accounts that still need portal verification',value:graphics.number(s.unverified),body:graphics.meter({label:'Verified or ready',value:Math.max(0,total-Number(s.unverified||0)),max:Math.max(total,1),tone:Number(s.unverified||0)?'warn':'good'}),tone:Number(s.unverified||0)?'warn':'good'},
        {title:'Support pressure',subtitle:'Operational people items',value:graphics.number(attention),body:graphics.bars([{name:'Past due',count:s.past_due||0},{name:'Disabled Jellyfin',count:s.disabled_accounts||0},{name:'Provisioning blocked',count:s.provisioning_attention||0}]),tone:attention?'warn':'good',href:'/admin/attention',linkLabel:'Review attention'}
    ])}`;
}
async function listPage(req){
    const filters=parseFilters(req.query);
    const page=Math.max(parseInt(req.query.page,10)||1,1);
    const sort=['expiring','name','recent'].includes(req.query.sort)?req.query.sort:'recent';
    const [options,result,overview]=await Promise.all([filterOptions(),customerFilters.listCustomers(filters,null,{page,pageSize:25,sort}),customerOverview()]);
    const rows=result.rows;
    const body=`${notice(req)}${customerOverviewHtml(overview)}${filterForm(filters,options)}<section class="section"><div class="sectionHead"><h2>Customers</h2><span class="muted">${result.total} total</span></div>${rows.length?`<div class="tableWrap"><table class="dataTable responsiveTable" id="customersTable"><thead><tr><th><input type="checkbox" id="checkAllPage" aria-label="Select all customers on this page"></th><th>Customer</th><th>Plan</th><th>Status</th><th>Expires</th><th>Jellyfin</th><th>Server</th><th>Reconciliation</th><th>Override</th><th>Last active</th></tr></thead><tbody>${rows.map(row).join('')}</tbody></table></div>${pagination(filters,result.page,result.pageSize,result.total)}`:'<div class="empty">No customers match these filters.</div>'}</section>${result.total?bulkBar(req,filters,result.total):''}<script src="/js/admin-customers-bulk.js" defer></script>`;
    return layout({siteName:site(),active:'users',title:'Customers',subtitle:'Managed customers, subscriptions and Jellyfin access',body,action:'<a class="button" href="/admin/users/new">Add customer</a> <a class="button secondary" href="/admin/jellyfin-import">Import from Jellyfin</a> <a class="button secondary" href="/admin/users/export?'+queryStringFor(filters)+'">Export CSV</a>'});
}

function createAdminCustomersListRouter(){
    const r=express.Router();
    r.use('/admin/users',gate,noStore);
    r.get('/admin/users',async(req,res,next)=>{try{return res.send(await listPage(req))}catch(e){next(e)}});
    r.get('/admin/users/export',async(req,res,next)=>{
        try{
            const filters=parseFilters(req.query);
            const rows=await customerFilters.exportRows(filters,null);
            return sendCsv(res,'customers.csv',[
                {key:'display_name',label:'Name'},{key:'login_username',label:'Username'},{key:'email',label:'Email'},
                {key:'plan_name',label:'Plan'},{key:'subscription_status',label:'Status'},
                {label:'Expires',value:x=>x.current_period_end||''},{key:'account_count',label:'Jellyfin accounts'},
                {key:'server_names',label:'Jellyfin servers'},{key:'last_activity_at',label:'Last activity'}
            ],rows);
        }catch(e){next(e)}
    });
    return r;
}
module.exports={createAdminCustomersListRouter,parseFilters,queryStringFor,filterHiddenFields};
