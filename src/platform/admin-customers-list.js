'use strict';
const express=require('express');
const {query}=require('../db');
const {esc,layout}=require('./admin-html');
const csrf=require('../auth/csrf');
const customerFilters=require('./customer-filters');
const tableSort=require('./admin-table-sort');
const registry=require('../jellyfin/registry');
const {sendCsv}=require('./export');
const {BULK_ACTIONS}=require('./admin-bulk-customers');
const graphics=require('./admin-section-graphics');
const {customerIdentity}=require('./customer-list-identity');

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired')}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next()}
function site(){return process.env.SITE_NAME||'CAPTAiNFiN'}
function t(v,max=200){return String(v||'').trim().slice(0,max)}
function pill(v,k=''){return `<span class="pill ${k}">${esc(v)}</span>`}
function notice(req){return `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`}
function serviceLabel(value){return value==='stremio'?'Stremio':value==='jellyfin'?'Jellyfin':value==='bundle'?'Jellyfin + Stremio':''}
function syncStatusLabel(value){return ({successful:'In sync',failed:'Failed',pending:'Pending',running:'Provisioning'})[String(value||'')]||String(value||'')}
function titleCase(value){return String(value||'').replace(/_/g,' ').replace(/\b\w/g,m=>m.toUpperCase())}

const PRESETS=['all','attention','active','trials','free','paid','no_plan'];
function parseFilters(q){
    const f={};
    if(q.q)f.q=t(q.q,80);
    if(customerFilters.SERVICE_VALUES.includes(q.service))f.service=q.service;
    if(q.server&&customerFilters.isUuid(q.server))f.serverId=q.server;
    if(q.plan&&customerFilters.isUuid(q.plan))f.planId=q.plan;
    if(customerFilters.STATUS_VALUES.includes(q.status)||q.status==='none')f.status=q.status;
    if(customerFilters.ACCESS_VALUES.includes(q.access))f.access=q.access;
    if(q.accountStatus==='portal_disabled')f.accountStatus='portal_disabled';
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
    if(PRESETS.includes(q.preset))f.preset=q.preset;

    // Quick presets are only shorthand for canonical filters. Explicit filter
    // fields still win, so URLs remain composable and bulk select-all receives
    // the exact same filter state as the visible customer list.
    if(f.preset==='attention'&&!f.access)f.access='attention';
    if(f.preset==='active'&&!f.access)f.access='active';
    if(f.preset==='trials'&&!q.status){f.billingInterval='trial';}
    if(f.preset==='free')f.priceType='free';
    if(f.preset==='paid')f.priceType='paid';
    if(f.preset==='no_plan'&&!f.status)f.status='none';
    return f;
}

function filterMap(filters){
    const map={preset:filters.preset,service:filters.service,q:filters.q,server:filters.serverId,plan:filters.planId,status:filters.status,access:filters.access,accountStatus:filters.accountStatus,paymentProvider:filters.paymentProvider,expiryFrom:filters.expiryFrom,expiryTo:filters.expiryTo,lastActiveFrom:filters.lastActiveFrom,lastActiveTo:filters.lastActiveTo,registeredFrom:filters.registeredFrom,registeredTo:filters.registeredTo,reconciliationStatus:filters.reconciliationStatus,library:filters.library};
    if(filters.hasOverride===true)map.hasOverride='1'; else if(filters.hasOverride===false)map.hasOverride='0';
    return map;
}
function filterHiddenFields(filters){return Object.entries(filterMap(filters)).filter(([,v])=>v!==undefined&&v!==null&&v!=='').map(([k,v])=>`<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}
function queryStringFor(filters,extra={}){const params=new URLSearchParams();for(const [k,v] of Object.entries(filterMap(filters)))if(v!==undefined&&v!==null&&v!=='')params.set(k,v);for(const [k,v] of Object.entries(extra))if(v!==undefined&&v!==null&&v!=='')params.set(k,v);return params.toString()}

async function filterOptions(){const [servers,plans]=await Promise.all([registry.listServers({enabledOnly:false}),query('SELECT id,name FROM plans ORDER BY sort_order,name')]);return{servers,plans:plans.rows}}
function optionList(items,current){return items.map(x=>`<option value="${esc(x.id)}" ${String(x.id)===String(current)?'selected':''}>${esc(x.name)}</option>`).join('')}
function clearHref(filters){return filters.service?`/admin/users?service=${encodeURIComponent(filters.service)}`:'/admin/users'}
function presetHref(filters,preset){const params=new URLSearchParams();if(filters.service)params.set('service',filters.service);if(preset!=='all')params.set('preset',preset);return `/admin/users${params.toString()?`?${params}`:''}`}
function quickPresets(filters){
    const items=[['all','All'],['attention','Needs attention'],['active','Active'],['trials','Trials'],['free','Free'],['paid','Paid'],['no_plan','No plan']];
    const current=filters.preset||'all';
    return `<nav class="customerQuickFilters" aria-label="Customer quick filters">${items.map(([key,label])=>`<a class="customerQuickFilter ${current===key?'active':''}" href="${esc(presetHref(filters,key))}">${esc(label)}</a>`).join('')}</nav>`;
}
function advancedActive(filters){return Boolean(filters.status||filters.accountStatus||filters.paymentProvider||filters.reconciliationStatus||filters.hasOverride!==undefined||filters.library||filters.expiryFrom||filters.expiryTo||filters.lastActiveFrom||filters.lastActiveTo||filters.registeredFrom||filters.registeredTo)}
function filterForm(filters,options,sort){
    const accessOptions=[['','Any access'],['active','Active'],['attention','Needs attention'],['provisioning','Provisioning'],['expired','Expired'],['no_entitlement','No entitlement'],['portal_disabled','Portal sign-in disabled']];
    return `${quickPresets(filters)}<form class="formPanel filterForm compactFilterForm customerFilterPanel" method="get" action="/admin/users">
        <input type="hidden" name="sort" value="${esc(sort.key)}"><input type="hidden" name="dir" value="${esc(sort.direction)}">
        <div class="customerPrimaryFilters">
            <div class="formGroup customerSearch"><label for="customerFilterSearch">Search</label><input class="input" id="customerFilterSearch" name="q" value="${esc(filters.q||'')}" placeholder="Name, email, username"></div>
            <div class="formGroup"><label for="customerFilterProduct">Product</label><select class="input" id="customerFilterProduct" name="service"><option value="">All products</option><option value="jellyfin" ${filters.service==='jellyfin'?'selected':''}>Jellyfin</option><option value="stremio" ${filters.service==='stremio'?'selected':''}>Stremio</option></select></div>
            <div class="formGroup"><label for="customerFilterPlan">Plan</label><select class="input" id="customerFilterPlan" name="plan"><option value="">Any plan</option>${optionList(options.plans,filters.planId)}</select></div>
            <div class="formGroup"><label for="customerFilterServer">Server</label><select class="input" id="customerFilterServer" name="server"><option value="">Any server</option>${optionList(options.servers,filters.serverId)}</select></div>
            <div class="formGroup"><label for="customerFilterAccess">Access</label><select class="input" id="customerFilterAccess" name="access">${accessOptions.map(([value,label])=>`<option value="${esc(value)}" ${filters.access===value?'selected':''}>${esc(label)}</option>`).join('')}</select></div>
            <div class="customerFilterActions"><button class="button">Apply</button><a class="button secondary" href="${esc(clearHref(filters))}">Reset</a></div>
        </div>
        <details class="customerAdvancedFilters" ${advancedActive(filters)?'open':''}><summary>Advanced filters${advancedActive(filters)?' · active':''}</summary><div class="formGrid">
            <div class="formGroup"><label for="customerFilterSubscription">Subscription status</label><select class="input" id="customerFilterSubscription" name="status"><option value="">Any</option><option value="none" ${filters.status==='none'?'selected':''}>No subscription</option>${customerFilters.STATUS_VALUES.map(s=>`<option value="${esc(s)}" ${filters.status===s?'selected':''}>${esc(titleCase(s))}</option>`).join('')}</select></div>
            <div class="formGroup"><label for="customerFilterPayment">Payment provider</label><select class="input" id="customerFilterPayment" name="paymentProvider"><option value="">Any</option><option value="none" ${filters.paymentProvider==='none'?'selected':''}>None</option>${customerFilters.PAYMENT_PROVIDERS.map(pr=>`<option value="${esc(pr)}" ${filters.paymentProvider===pr?'selected':''}>${esc(titleCase(pr))}</option>`).join('')}</select></div>
            <div class="formGroup"><label for="customerFilterPortal">Portal sign-in</label><select class="input" id="customerFilterPortal" name="accountStatus"><option value="">Any</option><option value="portal_disabled" ${filters.accountStatus==='portal_disabled'?'selected':''}>Disabled</option></select></div>
            <div class="formGroup"><label for="customerFilterSync">Provisioning</label><select class="input" id="customerFilterSync" name="reconciliationStatus"><option value="">Any</option><option value="none" ${filters.reconciliationStatus==='none'?'selected':''}>No reconciliation record</option>${customerFilters.RECON_VALUES.map(s=>`<option value="${esc(s)}" ${filters.reconciliationStatus===s?'selected':''}>${esc(syncStatusLabel(s))}</option>`).join('')}</select></div>
            <div class="formGroup"><label for="customerFilterCustomAccess">Customer settings</label><select class="input" id="customerFilterCustomAccess" name="hasOverride"><option value="">Any</option><option value="1" ${filters.hasOverride===true?'selected':''}>Custom settings</option><option value="0" ${filters.hasOverride===false?'selected':''}>Standard settings</option></select></div>
            <div class="formGroup"><label for="customerFilterLibrary">Library</label><input class="input" id="customerFilterLibrary" name="library" value="${esc(filters.library||'')}" placeholder="Library name"></div>
            <div class="formGroup"><label for="customerFilterExpiryFrom">Expiry from</label><input class="input" id="customerFilterExpiryFrom" type="date" name="expiryFrom" value="${esc(filters.expiryFrom||'')}"></div>
            <div class="formGroup"><label for="customerFilterExpiryTo">Expiry to</label><input class="input" id="customerFilterExpiryTo" type="date" name="expiryTo" value="${esc(filters.expiryTo||'')}"></div>
            <div class="formGroup"><label for="customerFilterActiveFrom">Last active from</label><input class="input" id="customerFilterActiveFrom" type="date" name="lastActiveFrom" value="${esc(filters.lastActiveFrom||'')}"></div>
            <div class="formGroup"><label for="customerFilterActiveTo">Last active to</label><input class="input" id="customerFilterActiveTo" type="date" name="lastActiveTo" value="${esc(filters.lastActiveTo||'')}"></div>
            <div class="formGroup"><label for="customerFilterRegisteredFrom">Registered from</label><input class="input" id="customerFilterRegisteredFrom" type="date" name="registeredFrom" value="${esc(filters.registeredFrom||'')}"></div>
            <div class="formGroup"><label for="customerFilterRegisteredTo">Registered to</label><input class="input" id="customerFilterRegisteredTo" type="date" name="registeredTo" value="${esc(filters.registeredTo||'')}"></div>
        </div></details>
    </form>`;
}

function relativeTime(value,{never='Never'}={}){
    if(!value)return never;
    const ms=new Date(value).getTime()-Date.now(),future=ms>0,abs=Math.abs(ms);
    const units=[[86400000,'day'],[3600000,'hour'],[60000,'min']];
    for(const [size,name] of units){if(abs>=size){const n=Math.max(1,Math.round(abs/size));return future?`in ${n} ${name}${n===1?'':'s'}`:`${n} ${name}${n===1?'':'s'} ago`;}}
    return future?'in <1 min':'just now';
}
function expiryText(x){
    if(!x.plan_id)return '—';
    if(x.permanent_access)return 'Permanent';
    if(x.is_free_tier)return 'Activity based';
    if(!x.current_period_end)return '—';
    const expired=new Date(x.current_period_end).getTime()<=Date.now();
    if(expired)return 'Expired';
    if(x.billing_interval==='trial'||x.subscription_status==='trialing')return `Ends ${relativeTime(x.current_period_end)}`;
    if(['cancelled','paused'].includes(x.subscription_status))return `Ends ${relativeTime(x.current_period_end)}`;
    return `Renews ${relativeTime(x.current_period_end)}`;
}
function serviceServer(x){
    const service=serviceLabel(x.service_type)||'Jellyfin';
    let server=x.server_names||'—';
    if(x.service_type==='stremio'&&server!=='—')server=`${server} pool`;
    return `<strong>${esc(service)}</strong><div class="subText">${esc(server)}</div>`;
}
function rowState(x){
    const live=['active','trialing'].includes(x.subscription_status)&&(x.is_free_tier||!x.current_period_end||new Date(x.current_period_end)>new Date());
    const jellyfinRequired=['jellyfin','bundle',null,undefined].includes(x.service_type);
    const missing=live&&jellyfinRequired&&Number(x.customer_account_count||0)===0;
    const sync=x.recon_rank?{1:'failed',2:'pending',3:'running',4:'successful'}[x.recon_rank]:null;
    if(x.login_active===false)return{access:'Access blocked',tone:'bad',attention:'Portal sign-in disabled',action:'Review'};
    if(x.subscription_status==='past_due')return{access:'Payment issue',tone:'bad',attention:'Payment overdue',action:'Billing'};
    if(sync==='failed'||x.provisioning_status==='failed'||x.provisioning_status==='blocked')return{access:'Needs provisioning',tone:'bad',attention:'Provisioning failed',action:'Fix access'};
    if(missing)return{access:'Needs provisioning',tone:'bad',attention:'Subscription active · access missing',action:'Fix access'};
    if(sync==='pending'||sync==='running'||['pending','running'].includes(x.provisioning_status))return{access:'Provisioning',tone:'warn',attention:'Provisioning in progress',action:'Retry'};
    if(!x.plan_id)return{access:'No entitlement',tone:'',attention:'—',action:'Manage'};
    if(!live)return{access:'Expired',tone:'warn',attention:Number(x.account_count||0)>0?'Expired access still present':'—',action:'Review'};
    return{access:'Active',tone:'good',attention:'—',action:'Manage'};
}
function row(x){
    const identity=customerIdentity(x),customerName=identity.primary,state=rowState(x);
    const attentionTone=state.attention==='—'?'':state.attention.includes('in progress')?'warn':'bad';
    return `<tr data-customer-row>
        <td data-label=""><input type="checkbox" class="rowCheck" form="bulkForm" name="customerId" value="${esc(x.id)}" aria-label="Select ${esc(customerName)}"></td>
        <td data-label="Customer"><a class="mediaTitle" href="/admin/users/${esc(x.id)}">${esc(customerName)}</a>${identity.secondary?`<div class="subText">${esc(identity.secondary)}</div>`:''}</td>
        <td data-label="Plan"><strong>${esc(x.plan_name||'No plan')}</strong></td>
        <td data-label="Access">${pill(state.access,state.tone)}</td>
        <td data-label="Service / Server">${serviceServer(x)}</td>
        <td data-label="Expires / Renews">${esc(expiryText(x))}</td>
        <td data-label="Last active">${esc(relativeTime(x.last_activity_at))}</td>
        <td data-label="Attention">${state.attention==='—'?'—':pill(state.attention,attentionTone)}</td>
        <td data-label="Actions"><a class="button secondary btn-sm" href="/admin/users/${esc(x.id)}">${esc(state.action)}</a></td>
    </tr>`;
}
function sortHeader(filters,sort,label,key){const active=sort.key===key,dir=tableSort.nextDirection(sort,key,customerFilters.CUSTOMER_SORTS),aria=active?` aria-sort="${sort.direction==='asc'?'ascending':'descending'}"`:'',arrow=active?` <span class="sortArrow" aria-hidden="true">${sort.direction==='asc'?'↑':'↓'}</span>`:'';return `<th${aria}><a class="tableSortLink ${active?'active':''}" href="/admin/users?${queryStringFor(filters,{sort:key,dir,page:1})}">${esc(label)}${arrow}</a></th>`}
function pagination(filters,sort,page,pageSize,total){const pages=Math.max(Math.ceil(total/pageSize),1);if(pages<=1)return'';const links=[],state={sort:sort.key,dir:sort.direction};if(page>1)links.push(`<a class="button secondary btn-sm" href="/admin/users?${queryStringFor(filters,{...state,page:page-1})}">Previous</a>`);links.push(`<span class="muted">Page ${page} of ${pages}</span>`);if(page<pages)links.push(`<a class="button secondary btn-sm" href="/admin/users?${queryStringFor(filters,{...state,page:page+1})}">Next</a>`);return `<nav class="buttonRow" aria-label="Customer pages">${links.join('')}</nav>`}

function bulkBar(req,filters,total){
    return `<section class="customerBulkBar" data-bulk-bar hidden aria-live="polite"><form method="post" action="/admin/customers/bulk/preview" id="bulkForm" data-native-submit="true"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">${filterHiddenFields(filters)}<div class="customerBulkInner"><strong><span data-bulk-count>0</span> customers selected</strong><select class="input" id="customerBulkAction" name="action" required aria-label="Bulk action"><option value="">Choose an action</option>${BULK_ACTIONS.map(([key,label])=>`<option value="${esc(key)}">${esc(label)}</option>`).join('')}</select><label class="customerBulkAll"><input type="checkbox" name="selectAllMatching" value="1" data-select-all-matching> Select all ${total} matching</label><button class="button">Continue</button><button class="button secondary" type="button" data-clear-selection>Clear</button></div></form></section>`;
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
            (SELECT COUNT(DISTINCT customer_id)::int FROM jellyfin_accounts) jellyfin_ready,
            (SELECT COUNT(*)::int FROM customer_provisioning_state WHERE status IN('blocked','failed')) provisioning_attention,
            (SELECT COUNT(DISTINCT c.id)::int FROM customers c JOIN app_users u ON u.id=c.user_id WHERE u.email_verified_at IS NULL) unverified`).catch(()=>({rows:[{}]})),
        query(`SELECT COALESCE(p.name,'No active plan') name,COUNT(DISTINCT c.id)::int count FROM customers c LEFT JOIN subscriptions s ON s.customer_id=c.id AND s.superseded_by IS NULL AND s.status IN('active','trialing') AND s.current_period_end>NOW() LEFT JOIN plans p ON p.id=s.plan_id GROUP BY 1 ORDER BY count DESC,name LIMIT 6`).catch(()=>({rows:[]}))
    ]);
    return{summary:summary.rows[0]||{},plans:plans.rows};
}
function customerOverviewHtml(data){
    const s=data.summary,total=Number(s.total||0),ready=Number(s.jellyfin_ready||0),active=Number(s.active_access||0),attention=Number(s.provisioning_attention||0)+Number(s.past_due||0);
    return `${graphics.hero({title:'Customer health',subtitle:'Customer growth, active access, service readiness and support needs in one view.',tone:attention?'warn':'good',stats:[graphics.stat({label:'Customers',value:graphics.number(total),meta:`${graphics.number(s.new_30d)} joined in 30 days`,tone:'blue',href:'/admin/users?sort=recent'}),graphics.stat({label:'Active access',value:graphics.number(active),meta:`${graphics.number(s.portal_enabled)} customer sign-ins enabled`,tone:'good'}),graphics.stat({label:'Recently active',value:graphics.number(s.active_30d),meta:'played in the last 30 days',tone:'violet'}),graphics.stat({label:'Needs attention',value:graphics.number(attention),meta:'past due or access setup blocked',tone:attention?'warn':'good',href:'/admin/users?preset=attention'})],meters:[graphics.meter({label:'Jellyfin readiness',value:ready,max:Math.max(total,ready),tone:ready>=active?'good':'blue',meta:`${graphics.number(ready)} managed Jellyfin identities present`})],actions:'<a class="button secondary" href="/admin/users/new">Add customer</a><a class="button secondary" href="/admin/jellyfin-import">Import Jellyfin users</a>'})}${graphics.insightGrid([{title:'Plan mix',subtitle:'Current active and trialing customers',value:graphics.number(active),body:graphics.bars(data.plans),tone:'blue',href:'/admin/plans',linkLabel:'Open plans'},{title:'Activation',subtitle:'Customers who still need to verify their account',value:graphics.number(s.unverified),body:graphics.meter({label:'Verified or ready',value:Math.max(0,total-Number(s.unverified||0)),max:Math.max(total,1),tone:Number(s.unverified||0)?'warn':'good'}),tone:Number(s.unverified||0)?'warn':'good'},{title:'Support pressure',subtitle:'Customer issues needing review',value:graphics.number(attention),body:graphics.bars([{name:'Past due',count:s.past_due||0},{name:'Access setup blocked',count:s.provisioning_attention||0}]),tone:attention?'warn':'good',href:'/admin/users?preset=attention',linkLabel:'Review attention'}])}`;
}
function productContext(filters){if(!filters.service)return'';const label=serviceLabel(filters.service);return `<div class="securityNote standalone"><strong>${esc(label)} customer context</strong><div class="subText">This is the shared customer system filtered to customers with ${esc(label)} or bundle history. Change the Product filter below to switch context.</div></div>`}
async function listPage(req){
    const filters=parseFilters(req.query),page=Math.max(parseInt(req.query.page,10)||1,1),sort=customerFilters.normalizeCustomerSort(req.query);
    const [options,result,overview]=await Promise.all([filterOptions(),customerFilters.listCustomers(filters,null,{page,pageSize:25,sort}),filters.service?Promise.resolve(null):customerOverview()]);
    const rows=result.rows,sortState=result.sort,context=serviceLabel(filters.service),active=filters.service==='jellyfin'?'jellyfin-customers':filters.service==='stremio'?'stremio-customers':'users';
    const headers=`<th><input type="checkbox" id="checkAllPage" aria-label="Select all customers on this page"></th>${sortHeader(filters,sortState,'Customer','name')}${sortHeader(filters,sortState,'Plan','plan')}${sortHeader(filters,sortState,'Access','access')}${sortHeader(filters,sortState,'Service / Server','server')}${sortHeader(filters,sortState,'Expires / Renews','expiring')}${sortHeader(filters,sortState,'Last active','recent')}${sortHeader(filters,sortState,'Attention','attention')}<th>Actions</th>`;
    const body=`<link rel="stylesheet" href="/css/admin-customers-list.css">${notice(req)}${filters.service?productContext(filters):customerOverviewHtml(overview)}${filterForm(filters,options,sortState)}<section class="section customerResults"><div class="sectionHead"><h2>${context?`${esc(context)} customers`:'Customers'}</h2><span class="muted">${result.total} total</span></div>${rows.length?`<div class="tableWrap"><table class="dataTable responsiveTable customerTable" id="customersTable"><caption class="srOnly">Customer results</caption><thead><tr>${headers}</tr></thead><tbody>${rows.map(row).join('')}</tbody></table></div>${pagination(filters,sortState,result.page,result.pageSize,result.total)}`:'<div class="empty">No customers match these filters.</div>'}</section>${result.total?bulkBar(req,filters,result.total):''}<script src="/js/admin-customers-bulk.js" defer></script>`;
    const common='<a class="button" href="/admin/users/new">Add customer</a>',jellyfinAction=filters.service==='stremio'?'':` <a class="button secondary" href="/admin/jellyfin-import">Import from Jellyfin</a>`;
    return layout({siteName:site(),active,title:context?`${context} customers`:'Customers',subtitle:context?`Shared customer records in ${context} context`:'Managed customers, subscriptions and service access',body,action:`${common}${jellyfinAction} <a class="button secondary" href="/admin/users/export?${queryStringFor(filters)}">Export CSV</a>`});
}

function createAdminCustomersListRouter(){
    const r=express.Router();r.use('/admin/users',gate,noStore);r.get('/admin/users',async(req,res,next)=>{try{return res.send(await listPage(req))}catch(e){next(e)}});r.get('/admin/users/export',async(req,res,next)=>{try{const filters=parseFilters(req.query),rows=await customerFilters.exportRows(filters,null);return sendCsv(res,'customers.csv',[{key:'display_name',label:'Name'},{key:'login_username',label:'Username'},{key:'email',label:'Email'},{key:'plan_name',label:'Plan'},{key:'subscription_status',label:'Status'},{key:'service_type',label:'Service'},{label:'Expires',value:x=>x.current_period_end||''},{key:'server_names',label:'Server / pool'},{key:'last_activity_at',label:'Last activity'}],rows)}catch(e){next(e)}});return r;
}
module.exports={createAdminCustomersListRouter,parseFilters,queryStringFor,filterHiddenFields,sortHeader};