'use strict';

const express = require('express');
const { query } = require('../db');
const runtimeSettings = require('./runtime-settings');
const { layout, esc } = require('./admin-html');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function text(value){return String(value||'').trim().slice(0,150);}
function table(headers,rows){if(!rows.length)return'<div class="empty">No matches.</div>';return `<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;}
function total(data){return Object.values(data).reduce((sum,rows)=>sum+(Array.isArray(rows)?rows.length:0),0);}

async function results(term){
    const q=text(term);
    if(q.length<2)return {customers:[],resellers:[],servers:[],plans:[],tiers:[],billing:[],resellerBilling:[]};
    const pattern=`%${q}%`;
    const [customers,resellers,servers,plans,tiers,billing,resellerBilling]=await Promise.all([
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
                ORDER BY COALESCE(access_expires_at,current_period_end) DESC,created_at DESC
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
        query(`SELECT r.id,u.username,u.email,rs.status,COALESCE(rs.tier_name_snapshot,rt.name) tier_name,
                   COALESCE(rs.tier_code_snapshot,rt.code) tier_code,rs.provider_subscription_id,rs.source
            FROM resellers r
            JOIN app_users u ON u.id=r.user_id
            LEFT JOIN LATERAL(
                SELECT * FROM reseller_subscriptions
                WHERE reseller_id=r.id
                ORDER BY current_period_end DESC,created_at DESC
                LIMIT 1
            ) rs ON TRUE
            LEFT JOIN reseller_tiers rt ON rt.id=rs.tier_id
            WHERE r.id::text ILIKE $1
               OR u.id::text ILIKE $1
               OR COALESCE(u.username,'') ILIKE $1
               OR COALESCE(u.email,'') ILIKE $1
               OR COALESCE(rs.provider_subscription_id,'') ILIKE $1
               OR COALESCE(rs.tier_name_snapshot,rt.name,'') ILIKE $1
               OR COALESCE(rs.tier_code_snapshot,rt.code,'') ILIKE $1
            ORDER BY u.username
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
        query(`SELECT id,code,name,monthly_price_minor,currency,seat_limit,active,visible,version_number,effective_from,effective_until,catalogue_mode
            FROM reseller_tiers
            WHERE id::text ILIKE $1
               OR COALESCE(code,'') ILIKE $1
               OR COALESCE(name,'') ILIKE $1
               OR COALESCE(description,'') ILIKE $1
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
            LIMIT 75`,[pattern]),
        query(`SELECT rs.id,rs.reseller_id,rs.source,rs.status,rs.provider_customer_id,rs.provider_subscription_id,
                   u.username,u.email,COALESCE(rs.tier_name_snapshot,rt.name) tier_name,
                   COALESCE(rs.tier_code_snapshot,rt.code) tier_code
            FROM reseller_subscriptions rs
            JOIN resellers r ON r.id=rs.reseller_id
            JOIN app_users u ON u.id=r.user_id
            LEFT JOIN reseller_tiers rt ON rt.id=rs.tier_id
            WHERE rs.id::text ILIKE $1
               OR rs.reseller_id::text ILIKE $1
               OR COALESCE(rs.provider_subscription_id,'') ILIKE $1
               OR COALESCE(rs.provider_customer_id,'') ILIKE $1
               OR COALESCE(rs.tier_name_snapshot,rt.name,'') ILIKE $1
               OR COALESCE(rs.tier_code_snapshot,rt.code,'') ILIKE $1
            ORDER BY rs.updated_at DESC
            LIMIT 75`,[pattern])
    ]);
    return {customers:customers.rows,resellers:resellers.rows,servers:servers.rows,plans:plans.rows,tiers:tiers.rows,billing:billing.rows,resellerBilling:resellerBilling.rows};
}

function statusPill(value){const v=String(value||'—');const kind=['active','trialing','healthy'].includes(v)?'good':['past_due','degraded','scheduled'].includes(v)?'warn':['cancelled','expired','offline','archived'].includes(v)?'bad':'';return `<span class="pill ${kind}">${esc(v)}</span>`;}
function money(minor,currency='GBP'){try{return new Intl.NumberFormat('en-GB',{style:'currency',currency:String(currency||'GBP').trim(),minimumFractionDigits:2}).format(Number(minor||0)/100);}catch{return `${currency} ${(Number(minor||0)/100).toFixed(2)}`;}}

async function page(req){
    await runtimeSettings.ensureLoaded();
    const q=text(req.query.q);const data=await results(q),count=total(data);
    const body=`<form class="formPanel" method="get" action="/admin/search"><div class="formGroup"><label>Search everything</label><div class="buttonRow"><input class="input" style="min-width:min(680px,72vw)" name="q" value="${esc(q)}" placeholder="Name, email, Jellyfin user, plan/tier, server, UUID or provider ID" autofocus><button class="button">Search</button></div><div class="inlineHelp">Searches customers, resellers, Jellyfin identities, plans, reseller tiers, servers and Stripe/PayPal identifiers.</div></div></form>${q.length<2?'<div class="empty">Enter at least two characters.</div>':`<div class="statusBanner"><strong>${count}</strong> matching record${count===1?'':'s'} across all indexed admin areas.</div>
    <section class="section"><div class="sectionHead"><h2>Customers</h2><span class="muted">${data.customers.length}</span></div>${table(['Customer','Jellyfin','Plan / status',''],data.customers.map(row=>`<tr><td><strong>${esc(row.display_name||row.username||row.email||'Customer')}</strong><div class="subText">${esc(row.email||row.portal_email||row.username||'')}</div><div class="subText fingerprint">${esc(row.id)}</div></td><td>${esc(row.jellyfin_username||'—')}<div class="subText fingerprint">${esc(row.jellyfin_user_id||'')}</div></td><td>${esc(row.plan_name||'—')}${row.plan_code?`<div class="subText">${esc(row.plan_code)}</div>`:''}${row.subscription_status?statusPill(row.subscription_status):''}</td><td><a class="button secondary btn-sm" href="/admin/users/${esc(row.id)}">Open customer</a></td></tr>`))}</section>
    <section class="section"><div class="sectionHead"><h2>Resellers</h2><span class="muted">${data.resellers.length}</span></div>${table(['Reseller','Tier','Billing',''],data.resellers.map(row=>`<tr><td><strong>${esc(row.username)}</strong><div class="subText">${esc(row.email||'')}</div><div class="subText fingerprint">${esc(row.id)}</div></td><td>${esc(row.tier_name||'—')}<div class="subText">${esc(row.tier_code||'')}</div></td><td>${row.status?statusPill(row.status):'—'}<div class="subText fingerprint">${esc(row.provider_subscription_id||'')}</div></td><td><a class="button secondary btn-sm" href="/admin/reseller-management/${esc(row.id)}">Open reseller</a></td></tr>`))}</section>
    <section class="section"><div class="sectionHead"><h2>Plans</h2><span class="muted">${data.plans.length}</span></div>${table(['Plan','Commercial','State',''],data.plans.map(row=>`<tr><td><strong>${esc(row.name)}</strong><div class="subText">${esc(row.code)} · v${esc(row.version_number||1)} · ${esc(row.audience||'')}</div><div class="subText fingerprint">${esc(row.id)}</div></td><td>${esc(money(row.price_minor,row.currency))}<div class="subText">${esc(row.billing_interval||'custom')} · ${esc(row.server_class||'custom')}</div></td><td>${row.archived_at?statusPill('archived'):row.effective_from&&new Date(row.effective_from)>new Date()?statusPill('scheduled'):statusPill(row.active?'active':'inactive')}</td><td><a class="button secondary btn-sm" href="/admin/plans/${esc(row.id)}/edit">Manage plan</a></td></tr>`))}</section>
    <section class="section"><div class="sectionHead"><h2>Reseller plans</h2><span class="muted">${data.tiers.length}</span></div>${table(['Tier','Commercial','State',''],data.tiers.map(row=>`<tr><td><strong>${esc(row.name)}</strong><div class="subText">${esc(row.code)} · v${esc(row.version_number||1)} · ${esc(row.catalogue_mode||'all_eligible')}</div><div class="subText fingerprint">${esc(row.id)}</div></td><td>${esc(money(row.monthly_price_minor,row.currency))} / month<div class="subText">${esc(row.seat_limit)} seats</div></td><td>${row.effective_from&&new Date(row.effective_from)>new Date()?statusPill('scheduled'):statusPill(row.active?'active':'inactive')}</td><td><a class="button secondary btn-sm" href="/admin/reseller-tiers/${esc(row.id)}">Manage tier</a></td></tr>`))}</section>
    <section class="section"><div class="sectionHead"><h2>Servers</h2><span class="muted">${data.servers.length}</span></div>${table(['Server','URL','Health / placement',''],data.servers.map(row=>`<tr><td><strong>${esc(row.name)}</strong><div class="subText">${esc(row.slug||'')} · ${esc(row.server_class||'')}</div><div class="subText fingerprint">${esc(row.id)}</div></td><td>${esc(row.public_url||row.base_url||'—')}</td><td>${statusPill(row.health_status)} <span class="pill">${esc(row.placement_mode||'active')}</span></td><td><a class="button secondary btn-sm" href="/admin/servers/${esc(row.id)}/edit">Open server</a></td></tr>`))}</section>
    <section class="section"><div class="sectionHead"><h2>Direct billing contracts</h2><span class="muted">${data.billing.length}</span></div>${table(['Customer','Plan','Provider / status','Provider IDs'],data.billing.map(row=>`<tr><td><a href="/admin/users/${esc(row.customer_id)}">${esc(row.display_name||row.email||'Customer')}</a><div class="subText fingerprint">${esc(row.customer_id)}</div></td><td>${esc(row.plan_name||'—')}<div class="subText">${esc(row.plan_code||'')}</div></td><td>${esc(row.source||'—')} ${statusPill(row.status)}</td><td><div class="fingerprint">${esc(row.provider_subscription_id||'—')}</div><div class="subText fingerprint">${esc(row.provider_customer_id||'')}</div></td></tr>`))}</section>
    <section class="section"><div class="sectionHead"><h2>Reseller billing contracts</h2><span class="muted">${data.resellerBilling.length}</span></div>${table(['Reseller','Tier','Provider / status','Provider IDs'],data.resellerBilling.map(row=>`<tr><td><a href="/admin/reseller-management/${esc(row.reseller_id)}">${esc(row.username||row.email||'Reseller')}</a><div class="subText fingerprint">${esc(row.reseller_id)}</div></td><td>${esc(row.tier_name||'—')}<div class="subText">${esc(row.tier_code||'')}</div></td><td>${esc(row.source||'—')} ${statusPill(row.status)}</td><td><div class="fingerprint">${esc(row.provider_subscription_id||'—')}</div><div class="subText fingerprint">${esc(row.provider_customer_id||'')}</div></td></tr>`))}</section>`}`;
    return layout({siteName:runtimeSettings.siteName(),active:'search',title:'Search',subtitle:'One search across customers, resellers, catalogue, fleet and billing identities',body});
}

function createAdminSearchRouter(){const r=express.Router();r.use('/admin/search',gate,noStore);r.get('/admin/search',async(req,res,next)=>{try{return res.send(await page(req));}catch(error){next(error);}});return r;}
module.exports={createAdminSearchRouter,results,page,total};
