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
const {customerIdentity}=require('./customer-list-identity');
const moneyFormat=require('./money-format');
const supportTickets=require('../support/tickets');

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired')}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next()}
function site(){return process.env.SITE_NAME||'CAPTAiNFiN'}
function t(v,max=200){return String(v||'').trim().slice(0,max)}
function pill(v,k=''){return `<span class="pill ${k}">${esc(v)}</span>`}
function notice(req){return `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`}
function serviceLabel(value){return value==='stremio'?'Stremio':value==='jellyfin'?'Jellyfin':value==='bundle'?'Jellyfin + Stremio':''}
function syncStatusLabel(value){return ({successful:'In sync',failed:'Failed',pending:'Pending',running:'Provisioning'})[String(value||'')]||String(value||'')}
function titleCase(value){return String(value||'').replace(/_/g,' ').replace(/\b\w/g,m=>m.toUpperCase())}
function number(value){return Number(value||0).toLocaleString('en-GB')}
function pct(value,total){const n=Number(value||0),d=Math.max(Number(total||0),1);return Math.max(0,Math.min(100,Math.round((n/d)*100)))}
function formatDate(value){if(!value)return'—';const d=new Date(value);return Number.isNaN(d.getTime())?'—':d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}
function initials(value){const text=String(value||'C').trim();const words=text.split(/\s+/).filter(Boolean);if(words.length>1)return`${words[0][0]}${words[words.length-1][0]}`.toUpperCase();return text.slice(0,1).toUpperCase()||'C'}

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

    if(f.preset==='attention'&&!f.access)f.access='attention';
    if(f.preset==='active'&&!f.access)f.access='active';
    if(f.preset==='trials'&&!q.status)f.billingInterval='trial';
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

async function filterOptions(){const [servers,plans]=await Promise.all([registry.listServers({enabledOnly:false}),query('SELECT id,name FROM plans WHERE COALESCE(is_addon,FALSE)=FALSE ORDER BY sort_order,name')]);return{servers,plans:plans.rows}}
function optionList(items,current){return items.map(x=>`<option value="${esc(x.id)}" ${String(x.id)===String(current)?'selected':''}>${esc(x.name)}</option>`).join('')}
function clearHref(filters){return filters.service?`/admin/users?service=${encodeURIComponent(filters.service)}`:'/admin/users'}
function presetHref(filters,preset){const params=new URLSearchParams();if(filters.service)params.set('service',filters.service);if(preset!=='all')params.set('preset',preset);return `/admin/users${params.toString()?`?${params}`:''}`}
function quickPresets(filters,counts={}){
    const items=[['all','All'],['attention','Needs attention'],['active','Ready'],['trials','Trials'],['free','Free'],['paid','Paid'],['no_plan','No plan']];
    const current=filters.preset||'all';
    return `<nav class="customerQuickFilters" aria-label="Customer quick filters">${items.map(([key,label])=>{const count=counts[key];return `<a class="customerQuickFilter ${current===key?'active':''}" href="${esc(presetHref(filters,key))}"><span>${esc(label)}</span>${Number.isFinite(Number(count))?`<span class="customerQuickCount">${esc(number(count))}</span>`:''}</a>`}).join('')}</nav>`;
}
function advancedActive(filters){return Boolean(filters.status||filters.accountStatus||filters.paymentProvider||filters.reconciliationStatus||filters.hasOverride!==undefined||filters.library||filters.expiryFrom||filters.expiryTo||filters.lastActiveFrom||filters.lastActiveTo||filters.registeredFrom||filters.registeredTo)}
function filterForm(filters,options,sort,counts={}){
    const accessOptions=[['','All access states'],['active','Ready'],['needs_access','Needs access'],['provisioning','Provisioning'],['expired','Expired'],['no_entitlement','No entitlement']];
    const advanced=advancedActive(filters);
    return `<form class="customerFilterPanel compactFilterForm" method="get" action="/admin/users" data-native-submit="true">
        <input type="hidden" name="sort" value="${esc(sort.key)}"><input type="hidden" name="dir" value="${esc(sort.direction)}">
        <div class="customerPrimaryFilters" role="search" aria-label="Customer filters">
            <div class="customerSearch"><span class="customerSearchIcon" aria-hidden="true">⌕</span><label class="srOnly" for="customerFilterSearch">Search customers</label><input class="input" id="customerFilterSearch" type="search" name="q" value="${esc(filters.q||'')}" placeholder="Search customers, name or email…"></div>
            <div class="formGroup"><label class="srOnly" for="customerFilterProduct">Product</label><select class="input" id="customerFilterProduct" name="service" data-primary-filter><option value="">All products</option><option value="jellyfin" ${filters.service==='jellyfin'?'selected':''}>Jellyfin</option><option value="stremio" ${filters.service==='stremio'?'selected':''}>Stremio</option></select></div>
            <div class="formGroup"><label class="srOnly" for="customerFilterAccess">Access</label><select class="input" id="customerFilterAccess" name="access" data-primary-filter>${accessOptions.map(([value,label])=>`<option value="${esc(value)}" ${filters.access===value?'selected':''}>${esc(label)}</option>`).join('')}</select></div>
            <div class="formGroup"><label class="srOnly" for="customerFilterPlan">Plan</label><select class="input" id="customerFilterPlan" name="plan" data-primary-filter><option value="">All plans</option>${optionList(options.plans,filters.planId)}</select></div>
            <div class="formGroup"><label class="srOnly" for="customerFilterServer">Server</label><select class="input" id="customerFilterServer" name="server" data-primary-filter><option value="">All servers</option>${optionList(options.servers,filters.serverId)}</select></div>
            <details class="customerMoreFilters" ${advanced?'open':''}>
                <summary class="button secondary"><span aria-hidden="true">▽</span> More filters${advanced?' · active':''}</summary>
                <div class="customerMoreFiltersPanel">
                    <div class="formGroup"><label for="customerFilterSubscription">Subscription status</label><select class="input" id="customerFilterSubscription" name="status"><option value="">Any</option><option value="none" ${filters.status==='none'?'selected':''}>No subscription history</option>${customerFilters.STATUS_VALUES.map(s=>`<option value="${esc(s)}" ${filters.status===s?'selected':''}>${esc(titleCase(s))}</option>`).join('')}</select></div>
                    <div class="formGroup"><label for="customerFilterPayment">Payment provider</label><select class="input" id="customerFilterPayment" name="paymentProvider"><option value="">Any</option><option value="none" ${filters.paymentProvider==='none'?'selected':''}>None</option>${customerFilters.PAYMENT_PROVIDERS.map(pr=>`<option value="${esc(pr)}" ${filters.paymentProvider===pr?'selected':''}>${esc(titleCase(pr))}</option>`).join('')}</select></div>
                    <div class="formGroup"><label for="customerFilterPortal">Portal sign-in</label><select class="input" id="customerFilterPortal" name="accountStatus"><option value="">Any</option><option value="portal_disabled" ${filters.accountStatus==='portal_disabled'?'selected':''}>Disabled</option></select></div>
                    <div class="formGroup"><label for="customerFilterSync">Policy sync</label><select class="input" id="customerFilterSync" name="reconciliationStatus"><option value="">Any</option><option value="none" ${filters.reconciliationStatus==='none'?'selected':''}>No reconciliation record</option>${customerFilters.RECON_VALUES.map(s=>`<option value="${esc(s)}" ${filters.reconciliationStatus===s?'selected':''}>${esc(syncStatusLabel(s))}</option>`).join('')}</select></div>
                    <div class="formGroup"><label for="customerFilterCustomAccess">Customer settings</label><select class="input" id="customerFilterCustomAccess" name="hasOverride"><option value="">Any</option><option value="1" ${filters.hasOverride===true?'selected':''}>Custom settings</option><option value="0" ${filters.hasOverride===false?'selected':''}>Standard settings</option></select></div>
                    <div class="formGroup"><label for="customerFilterLibrary">Library</label><input class="input" id="customerFilterLibrary" name="library" value="${esc(filters.library||'')}" placeholder="Library name"></div>
                    <div class="formGroup"><label for="customerFilterExpiryFrom">Expiry from</label><input class="input" id="customerFilterExpiryFrom" type="date" name="expiryFrom" value="${esc(filters.expiryFrom||'')}"></div>
                    <div class="formGroup"><label for="customerFilterExpiryTo">Expiry to</label><input class="input" id="customerFilterExpiryTo" type="date" name="expiryTo" value="${esc(filters.expiryTo||'')}"></div>
                    <div class="formGroup"><label for="customerFilterActiveFrom">Last active from</label><input class="input" id="customerFilterActiveFrom" type="date" name="lastActiveFrom" value="${esc(filters.lastActiveFrom||'')}"></div>
                    <div class="formGroup"><label for="customerFilterActiveTo">Last active to</label><input class="input" id="customerFilterActiveTo" type="date" name="lastActiveTo" value="${esc(filters.lastActiveTo||'')}"></div>
                    <div class="formGroup"><label for="customerFilterRegisteredFrom">Registered from</label><input class="input" id="customerFilterRegisteredFrom" type="date" name="registeredFrom" value="${esc(filters.registeredFrom||'')}"></div>
                    <div class="formGroup"><label for="customerFilterRegisteredTo">Registered to</label><input class="input" id="customerFilterRegisteredTo" type="date" name="registeredTo" value="${esc(filters.registeredTo||'')}"></div>
                    <div class="customerMoreFilterActions"><button class="button" type="submit">Apply filters</button></div>
                </div>
            </details>
            <a class="button secondary customerResetButton" href="${esc(clearHref(filters))}" aria-label="Reset customer filters">↻ <span>Reset</span></a>
        </div>
        ${quickPresets(filters,counts)}
    </form>`;
}

function relativeTime(value,{never='Never'}={}){
    if(!value)return never;
    const ms=new Date(value).getTime()-Date.now();
    if(!Number.isFinite(ms))return never;
    const future=ms>0,abs=Math.abs(ms),units=[[86400000,'day'],[3600000,'hour'],[60000,'min']];
    for(const [size,name] of units){if(abs>=size){const n=Math.max(1,Math.round(abs/size));return future?`in ${n} ${name}${n===1?'':'s'}`:`${n} ${name}${n===1?'':'s'} ago`;}}
    return future?'in <1 min':'just now';
}
function expiryInfo(x){
    if(!x.plan_id)return{primary:'—',secondary:''};
    if(x.permanent_access)return{primary:'Permanent',secondary:'No expiry'};
    if(x.is_free_tier)return{primary:'—',secondary:''};
    const end=x.access_expires_at||x.current_period_end;
    if(!end)return{primary:'—',secondary:''};
    if(!x.has_current_entitlement)return{primary:formatDate(end),secondary:`Expired ${relativeTime(end)}`,tone:'bad'};
    if(x.billing_interval==='trial'||x.subscription_status==='trialing')return{primary:formatDate(end),secondary:`Ends ${relativeTime(end)}`,tone:'warn'};
    if(['past_due','paused','cancelled','expired'].includes(x.subscription_status))return{primary:formatDate(end),secondary:`Access ${relativeTime(end)}`,tone:'warn'};
    return{primary:formatDate(end),secondary:relativeTime(end)};
}
function planCommercialType(x){
    if(!x.plan_id)return'No plan';
    if(x.billing_interval==='trial'||x.subscription_status==='trialing')return'Trial';
    if(x.is_free_tier)return'Free';
    const label=({month:'Monthly','6_months':'6 months',year:'Yearly',custom:'Paid'})[String(x.billing_interval||'')]||'Paid';
    return label==='Paid'?'Paid':`${label} - Paid`;
}
function planPriceMeta(x){
    if(!x.plan_id)return'No payment record';
    if(x.is_free_tier)return'No payment required';
    if(x.billing_interval==='trial'||x.subscription_status==='trialing')return'No charge during trial';
    const money=moneyFormat.formatMinor(Number(x.price_minor||0),'USD',{trimZeroDecimals:true});
    const suffix=({month:' / month','6_months':' / 6 months',year:' / year'})[String(x.billing_interval||'')]||'';
    return `${money}${suffix}`;
}
function rowState(x){
    const current=x.has_current_entitlement===true;
    const jellyfinRequired=['jellyfin','bundle',null,undefined].includes(x.service_type);
    const jfCount=Number(x.customer_account_count||0);
    const missing=current&&jellyfinRequired&&jfCount===0;
    const provisioning=['pending','running'].includes(String(x.provisioning_status||''));
    const failed=['failed','blocked'].includes(String(x.provisioning_status||''));
    const reconFailed=Number(x.recon_rank||0)===1;
    if(missing&&provisioning)return{access:'Provisioning',tone:'warn',reason:'Creating Jellyfin access',action:'Open'};
    if(missing)return{access:'Needs access',tone:'bad',reason:failed?'Jellyfin provisioning failed':'Jellyfin account missing',action:'Fix access'};
    if(current){
        if(x.subscription_status==='past_due')return{access:'Ready',tone:'good',reason:'Access present · payment past due',action:'Billing'};
        if(jellyfinRequired&&reconFailed)return{access:'Ready',tone:'good',reason:'Access present · policy sync failed',action:'Review'};
        if(x.permanent_access)return{access:'Ready',tone:'good',reason:'Permanent access',action:'Open'};
        if(x.is_free_tier)return{access:'Ready',tone:'good',reason:'All good',action:'Open'};
        if(x.subscription_status==='trialing')return{access:'Ready',tone:'good',reason:'Trial access active',action:'Open'};
        return{access:'Ready',tone:'good',reason:'All good',action:'Open'};
    }
    if(x.plan_id){
        const stale=jfCount>0;
        return{access:'Expired',tone:stale?'bad':'warn',reason:stale?'Jellyfin access still present':'No current entitlement',action:stale?'Remove access':'Open'};
    }
    return{access:'No entitlement',tone:'',reason:'No active subscription',action:'Open'};
}
function serviceCell(x,state){
    const current=x.has_current_entitlement===true;
    const type=String(x.service_type||'jellyfin');
    const jfCount=Number(x.customer_account_count||0);
    if(type==='stremio')return `<div class="customerServiceState ${current?'good':''}"><span class="customerStateDot"></span><strong>${current?'Active':'Not active'}</strong></div><div class="subText">Stremio${current?' entitlement active':' · no active entitlement'}</div>`;
    if(jfCount>0){
        if(current)return `<div class="customerServiceState good"><span class="customerStateDot"></span><strong>Active</strong></div>${x.jellyfin_username?`<div class="subText">${esc(x.jellyfin_username)}</div>`:'<div class="subText">Jellyfin linked</div>'}`;
        return `<div class="customerServiceState bad"><span class="customerStateDot"></span><strong>Still present</strong></div>${x.jellyfin_username?`<div class="subText">${esc(x.jellyfin_username)} · remove access</div>`:'<div class="subText">Jellyfin access should be removed</div>'}`;
    }
    if(current)return `<div class="customerServiceState ${state.access==='Provisioning'?'warn':'bad'}"><span class="customerStateDot"></span><strong>${state.access==='Provisioning'?'Provisioning':'Not linked'}</strong></div><div class="subText">Add Jellyfin access</div>`;
    return `<div class="customerServiceState"><span class="customerStateDot"></span><strong>Not linked</strong></div><div class="subText">No Jellyfin account</div>`;
}
function serverCell(x){return x.server_names?`<strong>${esc(x.server_names)}</strong>`:'<span class="muted">—</span>'}
function row(x){
    const identity=customerIdentity(x),customerName=identity.primary,state=rowState(x),expiry=expiryInfo(x);
    const portalNote=x.login_active===false?'<div class="subText customerPortalWarning">Portal sign-in disabled</div>':'';
    const last=x.last_activity_at?{primary:relativeTime(x.last_activity_at),secondary:formatDate(x.last_activity_at)}:{primary:'Never',secondary:''};
    return `<tr data-customer-row>
        <td data-label=""><input type="checkbox" class="rowCheck" form="bulkForm" name="customerId" value="${esc(x.id)}" aria-label="Select ${esc(customerName)}"></td>
        <td data-label="Customer"><div class="customerIdentityCell"><span class="customerAvatar" aria-hidden="true">${esc(initials(customerName))}</span><div><a class="mediaTitle" href="/admin/users/${esc(x.id)}">${esc(customerName)}</a>${identity.secondary?`<div class="subText">${esc(identity.secondary)}</div>`:''}${portalNote}</div></div></td>
        <td data-label="Plan / product"><strong>${esc(planCommercialType(x))}</strong><div class="subText">${esc(planPriceMeta(x))}</div></td>
        <td data-label="Access status">${pill(state.access,state.tone)}<div class="subText customerAccessReason">${esc(state.reason)}</div></td>
        <td data-label="Jellyfin / service">${serviceCell(x,state)}</td>
        <td data-label="Server">${serverCell(x)}</td>
        <td data-label="Renewal / expiry"><strong class="${expiry.tone?`customerDateTone ${expiry.tone}`:''}">${esc(expiry.primary)}</strong>${expiry.secondary?`<div class="subText ${expiry.tone?`customerDateTone ${expiry.tone}`:''}">${esc(expiry.secondary)}</div>`:''}</td>
        <td data-label="Last active"><strong>${esc(last.primary)}</strong>${last.secondary?`<div class="subText">${esc(last.secondary)}</div>`:''}</td>
        <td data-label="Actions"><div class="customerRowActions"><a class="button secondary btn-sm" href="/admin/users/${esc(x.id)}">${esc(state.action)}</a><a class="customerRowMenu" href="/admin/users/${esc(x.id)}" aria-label="More actions for ${esc(customerName)}">•••</a></div></td>
    </tr>`;
}
function sortHeader(filters,sort,label,key,pageSize){const active=sort.key===key,dir=tableSort.nextDirection(sort,key,customerFilters.CUSTOMER_SORTS),aria=active?` aria-sort="${sort.direction==='asc'?'ascending':'descending'}"`:'',arrow=active?` <span class="sortArrow" aria-hidden="true">${sort.direction==='asc'?'↑':'↓'}</span>`:'';return `<th${aria}><a class="tableSortLink ${active?'active':''}" href="/admin/users?${queryStringFor(filters,{sort:key,dir,page:1,pageSize})}">${esc(label)}${arrow}</a></th>`}
function pageHref(filters,sort,page,pageSize){return `/admin/users?${queryStringFor(filters,{sort:sort.key,dir:sort.direction,page,pageSize})}`}
function pagination(filters,sort,page,pageSize,total){
    const pages=Math.max(Math.ceil(total/pageSize),1);if(pages<=1)return'';
    const nums=new Set([1,pages,page]);for(let i=1;i<=2;i++){if(page-i>1)nums.add(page-i);if(page+i<pages)nums.add(page+i)}
    const ordered=[...nums].sort((a,b)=>a-b),parts=[];let prev=0;
    for(const n of ordered){if(prev&&n-prev>1)parts.push('<span class="customerPageEllipsis">…</span>');parts.push(n===page?`<span class="customerPageLink active" aria-current="page">${n}</span>`:`<a class="customerPageLink" href="${esc(pageHref(filters,sort,n,pageSize))}">${n}</a>`);prev=n}
    return `<nav class="customerPagination" aria-label="Customer pages"><a class="customerPageArrow ${page<=1?'disabled':''}" ${page>1?`href="${esc(pageHref(filters,sort,page-1,pageSize))}"`:'aria-disabled="true"'}>‹</a>${parts.join('')}<a class="customerPageArrow ${page>=pages?'disabled':''}" ${page<pages?`href="${esc(pageHref(filters,sort,page+1,pageSize))}"`:'aria-disabled="true"'}>›</a></nav>`;
}

function bulkBar(req,filters,total){
    return `<section class="customerBulkBar" data-bulk-bar hidden aria-live="polite"><form method="post" action="/admin/customers/bulk/preview" id="bulkForm" data-native-submit="true"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">${filterHiddenFields(filters)}<div class="customerBulkInner"><strong><span data-bulk-count>0</span> customers selected</strong><select class="input" id="customerBulkAction" name="action" required aria-label="Bulk action"><option value="">Choose an action</option>${BULK_ACTIONS.map(([key,label])=>`<option value="${esc(key)}">${esc(label)}</option>`).join('')}</select><label class="customerBulkAll"><input type="checkbox" name="selectAllMatching" value="1" data-select-all-matching> Select all ${total} matching</label><button class="button">Continue</button><button class="button secondary" type="button" data-clear-selection>Clear</button></div></form></section>`;
}

function kpiIcon(kind){
    const icons={customers:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>',active:'<polygon points="5 3 19 12 5 21 5 3"/>',recent:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',attention:'<path d="M10.3 3.4 2.2 18a2 2 0 0 0 1.8 3h16a2 2 0 0 0 1.8-3L13.7 3.4a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>'};
    return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icons[kind]||icons.customers}</svg>`;
}
function kpiCard({kind,label,value,meta,detail,tone='blue'}){return `<article class="customerKpi ${tone}"><div class="customerKpiIcon">${kpiIcon(kind)}</div><div class="customerKpiBody"><span>${esc(label)}</span><strong>${esc(number(value))}</strong><small>${esc(meta||'')}</small></div>${detail?`<div class="customerKpiDelta ${tone}">${esc(detail)}</div>`:''}</article>`}
function healthPanel({total,healthy,attention}){
    const inactive=Math.max(0,total-healthy-attention),healthyPct=pct(healthy,total),attentionPct=pct(attention,total),inactivePct=Math.max(0,100-healthyPct-attentionPct);
    return `<article class="customerInsight customerHealthPanel"><div class="customerInsightHead"><div><h3><span class="customerInsightIcon good">♡</span> Customer health</h3><p>Overall customer access and service readiness.</p></div><div class="customerInsightTotal"><strong>${esc(number(total))}</strong><span>total</span></div></div><div class="customerHealthBar" aria-label="${healthyPct}% active and healthy, ${attentionPct}% needs attention, ${inactivePct}% inactive or no access"><span class="good" style="width:${healthyPct}%">${healthyPct>=8?`${healthyPct}%`:''}</span><span class="bad" style="width:${attentionPct}%">${attentionPct>=4?`${attentionPct}%`:''}</span><span class="neutral" style="width:${inactivePct}%">${inactivePct>=8?`${inactivePct}%`:''}</span></div><div class="customerHealthLegend"><span><i class="good"></i>Active & healthy <strong>${esc(number(healthy))}</strong></span><span><i class="bad"></i>Needs attention <strong>${esc(number(attention))}</strong></span><span><i></i>Inactive / no access <strong>${esc(number(inactive))}</strong></span></div></article>`;
}
function planMixPanel(plans,total){
    const colors=['#45b7ff','#7b8cff','#45d0c2','#b4e76d','#ffd064','#8d67dc','#748291'];
    const rows=(plans||[]).slice(0,7),denom=Math.max(Number(total||0),1);let cursor=0;
    const stops=rows.map((row,index)=>{const start=cursor,share=(Number(row.count||0)/denom)*100;cursor+=share;return `${colors[index%colors.length]} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`});
    if(cursor<100)stops.push(`#25323e ${cursor.toFixed(2)}% 100%`);
    return `<article class="customerInsight customerPlanMix"><div class="customerInsightHead"><div><h3><span class="customerInsightIcon blue">⌁</span> Plan mix</h3><p>Current customer distribution.</p></div></div><div class="customerPlanMixBody"><div class="customerPlanDonut" style="background:conic-gradient(${esc(stops.join(','))})"><div><strong>${esc(number(total))}</strong><span>customers</span></div></div><div class="customerPlanLegend">${rows.map((row,index)=>`<div><span class="customerPlanName"><i style="background:${colors[index%colors.length]}"></i>${esc(row.name)}</span><strong>${esc(number(row.count))}</strong><span>${pct(row.count,total)}%</span></div>`).join('')}</div></div></article>`;
}
function readinessRow(label,value,total,tone='good'){return `<div class="customerReadinessRow"><span>${esc(label)}</span><strong>${esc(number(value))}</strong><div class="customerReadinessTrack"><i class="${tone}" style="width:${pct(value,total)}%"></i></div><small>${pct(value,total)}%</small></div>`}
function accessSupportPanel(summary,supportCount,total){return `<article class="customerInsight customerReadiness"><div class="customerInsightHead"><div><h3><span class="customerInsightIcon blue">⚙</span> Access & support</h3><p>Activation, service readiness and support.</p></div></div><div class="customerReadinessRows">${readinessRow('Activated & ready',summary.ready_access||0,total,'good')}${readinessRow('Pending activation',summary.provisioning_pending||0,total,'blue')}${readinessRow('Missing Jellyfin access',summary.missing_jellyfin||0,total,'bad')}${readinessRow('Support requests',supportCount||0,total,'warn')}</div></article>`}
async function customerOverview(){
    const [summary,plans,support]=await Promise.all([
        query(`SELECT
            (SELECT COUNT(*)::int FROM customers) total,
            (SELECT COUNT(*)::int FROM customers WHERE created_at>=NOW()-INTERVAL '30 days') new_30d,
            (SELECT COUNT(DISTINCT customer_id)::int FROM playback_history WHERE customer_id IS NOT NULL AND started_at>=NOW()-INTERVAL '30 days') active_30d,
            (SELECT COUNT(DISTINCT customer_id)::int FROM effective_customer_entitlements) active_access,
            (SELECT COUNT(DISTINCT e.customer_id)::int FROM effective_customer_entitlements e
                WHERE COALESCE(NULLIF(e.service_type_snapshot,''),e.service_type,'jellyfin') NOT IN ('jellyfin','bundle')
                   OR EXISTS(SELECT 1 FROM jellyfin_accounts ja WHERE ja.customer_id=e.customer_id AND ja.account_purpose='jellyfin')) ready_access,
            (SELECT COUNT(DISTINCT e.customer_id)::int FROM effective_customer_entitlements e
                WHERE COALESCE(NULLIF(e.service_type_snapshot,''),e.service_type,'jellyfin') IN ('jellyfin','bundle')
                  AND NOT EXISTS(SELECT 1 FROM jellyfin_accounts ja WHERE ja.customer_id=e.customer_id AND ja.account_purpose='jellyfin')) missing_jellyfin,
            (SELECT COUNT(DISTINCT e.customer_id)::int FROM effective_customer_entitlements e
                WHERE COALESCE(NULLIF(e.service_type_snapshot,''),e.service_type,'jellyfin') IN ('jellyfin','bundle')
                  AND NOT EXISTS(SELECT 1 FROM jellyfin_accounts ja WHERE ja.customer_id=e.customer_id AND ja.account_purpose='jellyfin')
                  AND EXISTS(SELECT 1 FROM customer_provisioning_state cps WHERE cps.customer_id=e.customer_id AND cps.status IN('pending','running'))) provisioning_pending,
            (SELECT COUNT(DISTINCT c.id)::int FROM customers c
                LEFT JOIN app_users au ON au.id=c.user_id
                WHERE au.active=FALSE
                   OR EXISTS(SELECT 1 FROM effective_customer_entitlements e
                       WHERE e.customer_id=c.id AND e.status='past_due')
                   OR EXISTS(SELECT 1 FROM effective_customer_entitlements e
                       WHERE e.customer_id=c.id
                         AND COALESCE(NULLIF(e.service_type_snapshot,''),e.service_type,'jellyfin') IN ('jellyfin','bundle')
                         AND NOT EXISTS(SELECT 1 FROM jellyfin_accounts ja WHERE ja.customer_id=c.id AND ja.account_purpose='jellyfin')
                         AND NOT EXISTS(SELECT 1 FROM customer_provisioning_state cps WHERE cps.customer_id=c.id AND cps.status IN('pending','running')))
                   OR EXISTS(SELECT 1 FROM effective_customer_entitlements e
                       WHERE e.customer_id=c.id
                         AND COALESCE(NULLIF(e.service_type_snapshot,''),e.service_type,'jellyfin') IN ('jellyfin','bundle')
                         AND EXISTS(SELECT 1 FROM jellyfin_accounts ja WHERE ja.customer_id=c.id AND ja.account_purpose='jellyfin')
                         AND EXISTS(SELECT 1 FROM jellyfin_accounts ja2 JOIN jellyfin_policy_reconciliation jpr ON jpr.jellyfin_account_id=ja2.id WHERE ja2.customer_id=c.id AND ja2.account_purpose='jellyfin' AND jpr.status='failed'))
                   OR (NOT EXISTS(SELECT 1 FROM effective_customer_entitlements e WHERE e.customer_id=c.id)
                       AND EXISTS(SELECT 1 FROM jellyfin_accounts ja WHERE ja.customer_id=c.id AND ja.account_purpose='jellyfin'))) attention,
            (SELECT COUNT(*)::int FROM effective_customer_entitlements e JOIN plans p ON p.id=e.plan_id WHERE p.billing_interval='trial' OR e.status='trialing') trials,
            (SELECT COUNT(*)::int FROM effective_customer_entitlements e JOIN plans p ON p.id=e.plan_id WHERE COALESCE(p.is_free_tier,FALSE)=TRUE OR COALESCE(p.price_minor,0)=0) free,
            (SELECT COUNT(*)::int FROM effective_customer_entitlements e JOIN plans p ON p.id=e.plan_id WHERE COALESCE(p.is_free_tier,FALSE)=FALSE AND COALESCE(p.price_minor,0)>0) paid,
            (SELECT COUNT(*)::int FROM customers c WHERE NOT EXISTS(SELECT 1 FROM subscriptions s WHERE s.customer_id=c.id)) no_plan
        `).catch(()=>({rows:[{}]})),
        query(`SELECT COALESCE(p.name,'No plan') name,COUNT(*)::int count FROM customers c LEFT JOIN effective_customer_entitlements e ON e.customer_id=c.id LEFT JOIN plans p ON p.id=e.plan_id GROUP BY 1 ORDER BY count DESC,name LIMIT 7`).catch(()=>({rows:[]})),
        supportTickets.staffQueueSummary().catch(()=>({count:0}))
    ]);
    const s=summary.rows[0]||{};
    const presets={all:Number(s.total||0),attention:Number(s.attention||0),active:Number(s.ready_access||0),trials:Number(s.trials||0),free:Number(s.free||0),paid:Number(s.paid||0),no_plan:Number(s.no_plan||0)};
    return{summary:s,plans:plans.rows,presets,supportCount:Number(support.count||0)};
}
function customerOverviewHtml(data){
    const s=data.summary||{},p=data.presets||{},total=Number(s.total||p.all||0),active=Number(s.active_access||0),ready=Number(p.active||s.ready_access||0),recent=Number(s.active_30d||0),attention=Number(p.attention||0),healthy=Math.max(0,Math.min(ready,total-attention));
    return `<section class="customerOverview"><div class="customerKpiGrid">${kpiCard({kind:'customers',label:'Total customers',value:total,meta:`${number(s.new_30d)} joined in the last 30 days`,detail:s.new_30d?`+${number(s.new_30d)}`:'',tone:'blue'})}${kpiCard({kind:'active',label:'Active access',value:active,meta:`${pct(active,total)}% of total`,detail:`${pct(active,total)}%`,tone:'good'})}${kpiCard({kind:'recent',label:'Recently active',value:recent,meta:'active in the last 30 days',detail:`${pct(recent,total)}%`,tone:'blue'})}${kpiCard({kind:'attention',label:'Needs attention',value:attention,meta:'need your attention',detail:attention?'Review':'Clear',tone:attention?'bad':'good'})}</div><div class="customerInsightGrid">${healthPanel({total,healthy,attention})}${planMixPanel(data.plans,total)}${accessSupportPanel(s,data.supportCount,total)}</div></section>`;
}
function productContext(filters){if(!filters.service)return'';const label=serviceLabel(filters.service);return `<div class="securityNote standalone"><strong>${esc(label)} customer context</strong><div class="subText">This is the shared customer system filtered to customers with ${esc(label)} or bundle history. Change the Product filter below to switch context.</div></div>`}
function tableToolbar(filters,sort,pageSize,total){
    const sortOptions=[['recent','Last active'],['attention','Needs attention'],['name','Customer name'],['plan','Plan'],['access','Access status'],['expiring','Renewal / expiry'],['server','Server']];
    return `<div class="customerTableToolbar"><div><h2>Customers <span>(${esc(number(total))})</span></h2></div><div class="customerTableControls"><form method="get" action="/admin/users" class="customerSortForm" data-auto-submit>${filterHiddenFields(filters)}<label for="customerSortSelect">Sort by</label><select class="input" id="customerSortSelect" name="sort"><option value="${esc(sort.key)}" selected hidden>${esc((sortOptions.find(([key])=>key===sort.key)||['','Last active'])[1])}</option>${sortOptions.filter(([key])=>key!==sort.key).map(([key,label])=>`<option value="${esc(key)}">${esc(label)}</option>`).join('')}</select><input type="hidden" name="dir" value="${esc(sort.direction)}"></form><div class="customerViewButtons" aria-label="Customer view"><span class="active" aria-label="List view">☷</span><span aria-hidden="true">▦</span></div><form method="get" action="/admin/users" class="customerPageSizeForm" data-auto-submit>${filterHiddenFields(filters)}<input type="hidden" name="sort" value="${esc(sort.key)}"><input type="hidden" name="dir" value="${esc(sort.direction)}"><label class="srOnly" for="customerPageSize">Rows per page</label><select class="input" id="customerPageSize" name="pageSize">${[25,50,100].map(size=>`<option value="${size}" ${size===pageSize?'selected':''}>${size} per page</option>`).join('')}</select></form></div></div>`;
}
async function listPage(req){
    const filters=parseFilters(req.query),page=Math.max(parseInt(req.query.page,10)||1,1),pageSize=[25,50,100].includes(parseInt(req.query.pageSize,10))?parseInt(req.query.pageSize,10):100;
    const requestedSort=req.query.sort?req.query:{sort:'recent',dir:'desc'},sort=customerFilters.normalizeCustomerSort(requestedSort);
    const [options,result,overview]=await Promise.all([filterOptions(),customerFilters.listCustomers(filters,null,{page,pageSize,sort}),filters.service?Promise.resolve(null):customerOverview()]);
    const rows=result.rows,sortState=result.sort,context=serviceLabel(filters.service),active=filters.service==='jellyfin'?'jellyfin-customers':filters.service==='stremio'?'stremio-customers':'users',counts=overview?.presets||{};
    const headers=`<th><input type="checkbox" id="checkAllPage" aria-label="Select all customers on this page"></th>${sortHeader(filters,sortState,'Customer','name',pageSize)}${sortHeader(filters,sortState,'Plan / product','plan',pageSize)}${sortHeader(filters,sortState,'Access status','access',pageSize)}<th>Jellyfin / service</th>${sortHeader(filters,sortState,'Server','server',pageSize)}${sortHeader(filters,sortState,'Renewal / expiry','expiring',pageSize)}${sortHeader(filters,sortState,'Last active','recent',pageSize)}<th>Actions</th>`;
    const resultMeta=`Showing ${rows.length?((result.page-1)*result.pageSize)+1:0}–${Math.min(result.page*result.pageSize,result.total)} of ${number(result.total)} customers`;
    const body=`<link rel="stylesheet" href="/css/admin-customers-list.css">${notice(req)}${filters.service?productContext(filters):customerOverviewHtml(overview)}${filterForm(filters,options,sortState,counts)}<section class="section customerResults">${tableToolbar(filters,sortState,result.pageSize,result.total)}${rows.length?`<div class="tableWrap"><table class="dataTable responsiveTable customerTable" id="customersTable"><caption class="srOnly">Customer results</caption><thead><tr>${headers}</tr></thead><tbody>${rows.map(row).join('')}</tbody></table></div><div class="customerTableFooter"><span class="muted">${esc(resultMeta)}</span>${pagination(filters,sortState,result.page,result.pageSize,result.total)}</div>`:'<div class="empty">No customers match these filters.</div>'}</section>${result.total?bulkBar(req,filters,result.total):''}<script src="/js/admin-customer-filters.js" defer></script><script src="/js/admin-customers-bulk.js" defer></script>`;
    const common='<a class="button" href="/admin/users/new">+ Add customer</a>',jellyfinAction=filters.service==='stremio'?'':` <a class="button secondary" href="/admin/jellyfin-import">Import from Jellyfin</a>`;
    return layout({siteName:site(),active,title:context?`${context} customers`:'Customers',subtitle:context?`Shared customer records in ${context} context`:'Manage customers, subscriptions and service access',body,action:`${common}${jellyfinAction} <a class="button secondary" href="/admin/users/export?${queryStringFor(filters)}">Export CSV</a>`});
}

function createAdminCustomersListRouter(){
    const r=express.Router();r.use('/admin/users',gate,noStore);r.get('/admin/users',async(req,res,next)=>{try{return res.send(await listPage(req))}catch(e){next(e)}});r.get('/admin/users/export',async(req,res,next)=>{try{const filters=parseFilters(req.query),rows=await customerFilters.exportRows(filters,null);return sendCsv(res,'customers.csv',[{key:'display_name',label:'Name'},{key:'login_username',label:'Username'},{key:'email',label:'Email'},{key:'plan_name',label:'Plan'},{key:'subscription_status',label:'Status'},{key:'service_type',label:'Service'},{label:'Expires',value:x=>x.access_expires_at||x.current_period_end||''},{key:'server_names',label:'Server'},{key:'last_activity_at',label:'Last activity'}],rows)}catch(e){next(e)}});return r;
}
module.exports={createAdminCustomersListRouter,parseFilters,queryStringFor,filterHiddenFields,sortHeader};