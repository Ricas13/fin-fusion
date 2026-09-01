'use strict';

const moneyFormat=require('./money-format');

const express = require('express');
const { query } = require('../db');
const runtimeSettings = require('./runtime-settings');
const { layout, esc } = require('./admin-html');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function text(value){return String(value||'').trim().slice(0,150);}
function table(headers,rows){if(!rows.length)return'<div class="empty">No matches.</div>';return `<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;}
function total(data){return Object.values(data).reduce((sum,rows)=>sum+(Array.isArray(rows)?rows.length:0),0);}
function technicalDetails(items){
    const rows=(items||[]).filter(item=>item?.value).map(item=>`<div><span>${esc(item.label)}</span><code>${esc(item.value)}</code></div>`);
    if(!rows.length)return'';
    return `<details class="searchTechnical"><summary>Technical identifiers</summary><div class="searchTechnicalBody">${rows.join('')}</div></details>`;
}

async function results(term){
    const q=text(term);
    if(q.length<2)return {customers:[],servers:[],plans:[],billing:[]};
    const pattern=`%${q}%`;
    const [customers,servers,plans,billing]=await Promise.all([
        query(`SELECT DISTINCT c.id,c.display_name,c.email,u.username,u.email portal_email,
                   ja.jellyfin_username,ja.jellyfin_user_id,p.name plan_name,p.code plan_code,
                   s.status subscription_status,s.provider_subscription_id
            FROM customers c
            LEFT JOIN app_users u ON u.id=c.user_id
            LEFT JOIN jellyfin_accounts ja ON ja.customer_id=c.id
            LEFT JOIN LATERAL(
                SELECT plan_id,status,provider_subscription_id
                FROM subscriptions
                WHERE customer_id=c.id
                ORDER BY (current_period_end + (COALESCE(service_extension_days,0) * INTERVAL '1 day')) DESC,created_at DESC
                LIMIT 1
            ) s ON TRUE
            LEFT JOIN plans p ON p.id=s.plan_id
            WHERE c.id::text ILIKE $1
               OR COALESCE(c.display_name,'') ILIKE $1
               OR COALESCE(c.email,'') ILIKE $1
               OR COALESCE(u.username,'') ILIKE $1
               OR COALESCE(u.email,'') ILIKE $1
               OR COALESCE(ja.jellyfin_username,'') ILIKE $1
               OR COALESCE(ja.jellyfin_user_id,'') ILIKE $1
               OR COALESCE(p.name,'') ILIKE $1
               OR COALESCE(p.code,'') ILIKE $1
               OR COALESCE(s.provider_subscription_id,'') ILIKE $1
            ORDER BY c.display_name NULLS LAST,c.id
            LIMIT 75`,[pattern]),
        query(`SELECT id,name,slug,base_url,public_url,health_status,server_class,placement_mode
            FROM jellyfin_servers
            WHERE id::text ILIKE $1
               OR COALESCE(name,'') ILIKE $1
               OR COALESCE(slug,'') ILIKE $1
               OR COALESCE(base_url,'') ILIKE $1
               OR COALESCE(public_url,'') ILIKE $1
               OR COALESCE(server_class,'') ILIKE $1
            ORDER BY name
            LIMIT 50`,[pattern]),
        query(`SELECT id,code,name,audience,server_class,billing_interval,price_minor,currency,active,visible,archived_at,version_number,effective_from,effective_until
            FROM plans
            WHERE id::text ILIKE $1
               OR COALESCE(code,'') ILIKE $1
               OR COALESCE(name,'') ILIKE $1
               OR COALESCE(description,'') ILIKE $1
               OR COALESCE(audience,'') ILIKE $1
               OR COALESCE(server_class,'') ILIKE $1
            ORDER BY active DESC,sort_order,name
            LIMIT 50`,[pattern]),
        query(`SELECT s.id,s.customer_id,s.source,s.status,s.provider_customer_id,s.provider_subscription_id,
                   c.display_name,c.email,p.name plan_name,p.code plan_code
            FROM subscriptions s
            JOIN customers c ON c.id=s.customer_id
            LEFT JOIN plans p ON p.id=s.plan_id
            WHERE s.id::text ILIKE $1
               OR s.customer_id::text ILIKE $1
               OR COALESCE(s.provider_subscription_id,'') ILIKE $1
               OR COALESCE(s.provider_customer_id,'') ILIKE $1
               OR COALESCE(p.name,'') ILIKE $1
               OR COALESCE(p.code,'') ILIKE $1
            ORDER BY s.updated_at DESC
            LIMIT 75`,[pattern])
    ]);
    return {customers:customers.rows,servers:servers.rows,plans:plans.rows,billing:billing.rows};
}

function statusPill(value){const v=String(value||'—');const kind=['active','trialing','healthy'].includes(v)?'good':['past_due','degraded','scheduled'].includes(v)?'warn':['cancelled','expired','offline','archived'].includes(v)?'bad':'';return `<span class="pill ${kind}">${esc(v)}</span>`;}
function money(minor,currency='GBP'){return moneyFormat.formatMinor(minor,currency);}

async function page(req){
    await runtimeSettings.ensureLoaded();
    const q=text(req.query.q);const data=await results(q),count=total(data);
    const body=`<form class="formPanel searchPanel" method="get" action="/admin/search"><div class="formGroup"><label>Find anything</label><div class="buttonRow"><input class="input" style="min-width:min(680px,72vw)" name="q" value="${esc(q)}" placeholder="Name, email, Jellyfin user, plan, server or payment reference" autofocus><button class="button">Search</button></div><div class="inlineHelp">Exact UUIDs and provider identifiers are still searchable for troubleshooting, but they stay hidden from normal results.</div></div></form>${q.length<2?'<div class="empty">Enter at least two characters.</div>':`<div class="statusBanner"><strong>${count}</strong> matching record${count===1?'':'s'} across customers, plans, servers and billing.</div>
    <section class="section"><div class="sectionHead"><h2>Customers</h2><span class="muted">${data.customers.length}</span></div>${table(['Customer','Jellyfin','Plan / status',''],data.customers.map(row=>`<tr><td><strong>${esc(row.display_name||row.username||row.email||'Customer')}</strong><div class="subText">${esc(row.email||row.portal_email||row.username||'')}</div>${technicalDetails([{label:'Customer ID',value:row.id},{label:'Jellyfin user ID',value:row.jellyfin_user_id},{label:'Provider subscription',value:row.provider_subscription_id}])}</td><td>${esc(row.jellyfin_username||'Not linked')}</td><td>${esc(row.plan_name||'—')}${row.plan_code?`<div class="subText">${esc(row.plan_code)}</div>`:''}${row.subscription_status?statusPill(row.subscription_status):''}</td><td><a class="button secondary btn-sm" href="/admin/users/${esc(row.id)}">Open customer</a></td></tr>`))}</section>
    <section class="section"><div class="sectionHead"><h2>Plans</h2><span class="muted">${data.plans.length}</span></div>${table(['Plan','Commercial','State',''],data.plans.map(row=>`<tr><td><strong>${esc(row.name)}</strong><div class="subText">${esc(row.code)} · v${esc(row.version_number||1)} · ${esc(row.audience||'')}</div>${technicalDetails([{label:'Plan ID',value:row.id}])}</td><td>${esc(money(row.price_minor,row.currency))}<div class="subText">${esc(row.billing_interval||'custom')} · ${esc(row.server_class||'custom')}</div></td><td>${row.archived_at?statusPill('archived'):row.effective_from&&new Date(row.effective_from)>new Date()?statusPill('scheduled'):statusPill(row.active?'active':'inactive')}</td><td><a class="button secondary btn-sm" href="/admin/plans/${esc(row.id)}/edit">Manage plan</a></td></tr>`))}</section>
    <section class="section"><div class="sectionHead"><h2>Servers</h2><span class="muted">${data.servers.length}</span></div>${table(['Server','URL','Health / placement',''],data.servers.map(row=>`<tr><td><strong>${esc(row.name)}</strong><div class="subText">${esc(row.slug||'')} · ${esc(row.server_class||'')}</div>${technicalDetails([{label:'Server ID',value:row.id},{label:'Internal URL',value:row.public_url&&row.base_url&&row.public_url!==row.base_url?row.base_url:null}])}</td><td>${esc(row.public_url||row.base_url||'—')}</td><td>${statusPill(row.health_status)} <span class="pill">${esc(row.placement_mode||'active')}</span></td><td><a class="button secondary btn-sm" href="/admin/servers/${esc(row.id)}/edit">Open server</a></td></tr>`))}</section>
    <section class="section"><div class="sectionHead"><h2>Billing contracts</h2><span class="muted">${data.billing.length}</span></div>${table(['Customer','Plan','Provider / status',''],data.billing.map(row=>`<tr><td><strong>${esc(row.display_name||row.email||'Customer')}</strong><div class="subText">${esc(row.email||'')}</div></td><td>${esc(row.plan_name||'—')}<div class="subText">${esc(row.plan_code||'')}</div></td><td>${esc(row.source||'—')} ${statusPill(row.status)}${technicalDetails([{label:'Subscription ID',value:row.id},{label:'Provider subscription',value:row.provider_subscription_id},{label:'Provider customer',value:row.provider_customer_id}])}</td><td><a class="button secondary btn-sm" href="/admin/users/${esc(row.customer_id)}">Open customer</a></td></tr>`))}</section>`}`;
    return layout({siteName:runtimeSettings.siteName(),active:'search',title:'Search',subtitle:'Find customers, plans, servers and billing from one place',body:`${body}<style>.searchTechnical{margin-top:6px;font-size:11px}.searchTechnical summary{cursor:pointer;color:var(--muted)}.searchTechnicalBody{display:grid;gap:4px;margin-top:6px;padding:7px;border:1px solid var(--border);border-radius:7px;background:var(--panel2)}.searchTechnicalBody>div{display:grid;gap:2px}.searchTechnicalBody span{color:var(--muted)}.searchTechnicalBody code{overflow-wrap:anywhere;color:var(--text)}</style>`});
}

function createAdminSearchRouter(){const r=express.Router();r.use('/admin/search',gate,noStore);r.get('/admin/search',async(req,res,next)=>{try{return res.send(await page(req));}catch(error){next(error);}});return r;}
module.exports={createAdminSearchRouter,results,page,total,technicalDetails};
