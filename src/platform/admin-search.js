'use strict';

const express = require('express');
const { query } = require('../db');
const runtimeSettings = require('./runtime-settings');
const { layout, esc } = require('./admin-html');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function text(value){return String(value||'').trim().slice(0,150);}
function table(headers,rows){if(!rows.length)return'<div class="empty">No matches.</div>';return `<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;}

async function results(term){
    if(term.length<2)return {customers:[],resellers:[],servers:[],billing:[]};
    const pattern=`%${term}%`;
    const [customers,resellers,servers,billing]=await Promise.all([
        query(`SELECT DISTINCT c.id,c.display_name,c.email,u.username,ja.jellyfin_username,p.name plan_name
            FROM customers c LEFT JOIN app_users u ON u.id=c.user_id LEFT JOIN jellyfin_accounts ja ON ja.customer_id=c.id
            LEFT JOIN LATERAL(SELECT plan_id FROM subscriptions WHERE customer_id=c.id ORDER BY current_period_end DESC LIMIT 1)s ON TRUE
            LEFT JOIN plans p ON p.id=s.plan_id
            WHERE COALESCE(c.display_name,'') ILIKE $1 OR COALESCE(c.email,'') ILIKE $1 OR COALESCE(u.username,'') ILIKE $1 OR COALESCE(u.email,'') ILIKE $1 OR COALESCE(ja.jellyfin_username,'') ILIKE $1 OR COALESCE(ja.jellyfin_user_id,'') ILIKE $1
            ORDER BY c.display_name NULLS LAST LIMIT 50`,[pattern]),
        query(`SELECT r.id,u.username,u.email,rs.status,COALESCE(rs.tier_name_snapshot,rt.name) tier_name,rs.provider_subscription_id
            FROM resellers r JOIN app_users u ON u.id=r.user_id
            LEFT JOIN LATERAL(SELECT * FROM reseller_subscriptions WHERE reseller_id=r.id ORDER BY current_period_end DESC LIMIT 1)rs ON TRUE
            LEFT JOIN reseller_tiers rt ON rt.id=rs.tier_id
            WHERE COALESCE(u.username,'') ILIKE $1 OR COALESCE(u.email,'') ILIKE $1 OR COALESCE(rs.provider_subscription_id,'') ILIKE $1
            ORDER BY u.username LIMIT 50`,[pattern]),
        query(`SELECT id,name,slug,base_url,public_url,health_status FROM jellyfin_servers
            WHERE name ILIKE $1 OR slug ILIKE $1 OR base_url ILIKE $1 OR COALESCE(public_url,'') ILIKE $1 ORDER BY name LIMIT 50`,[pattern]),
        query(`SELECT s.id,s.customer_id,s.source,s.status,s.provider_customer_id,s.provider_subscription_id,c.display_name,c.email
            FROM subscriptions s JOIN customers c ON c.id=s.customer_id
            WHERE COALESCE(s.provider_subscription_id,'') ILIKE $1 OR COALESCE(s.provider_customer_id,'') ILIKE $1
            ORDER BY s.updated_at DESC LIMIT 50`,[pattern])
    ]);
    return {customers:customers.rows,resellers:resellers.rows,servers:servers.rows,billing:billing.rows};
}

async function page(req){
    await runtimeSettings.ensureLoaded();
    const q=text(req.query.q);const data=await results(q);
    const body=`<form class="formPanel" method="get" action="/admin/search"><div class="formGroup"><label>Search everything</label><div class="buttonRow"><input class="input" style="min-width:min(620px,70vw)" name="q" value="${esc(q)}" placeholder="Customer, email, Jellyfin username, reseller, server or provider ID" autofocus><button class="button">Search</button></div></div></form>${q.length<2?'<div class="empty">Enter at least two characters.</div>':`
    <section class="section"><div class="sectionHead"><h2>Customers</h2><span class="muted">${data.customers.length}</span></div>${table(['Customer','Jellyfin','Plan',''],data.customers.map(row=>`<tr><td><strong>${esc(row.display_name||row.username||row.email||'Customer')}</strong><div class="subText">${esc(row.email||row.username||'')}</div></td><td>${esc(row.jellyfin_username||'—')}</td><td>${esc(row.plan_name||'—')}</td><td><a class="button secondary btn-sm" href="/admin/users/${esc(row.id)}">Open</a></td></tr>`))}</section>
    <section class="section"><div class="sectionHead"><h2>Resellers</h2><span class="muted">${data.resellers.length}</span></div>${table(['Reseller','Tier','Billing',''],data.resellers.map(row=>`<tr><td><strong>${esc(row.username)}</strong><div class="subText">${esc(row.email||'')}</div></td><td>${esc(row.tier_name||'—')}</td><td>${esc(row.status||'—')}<div class="subText">${esc(row.provider_subscription_id||'')}</div></td><td><a class="button secondary btn-sm" href="/admin/reseller-management/${esc(row.id)}">Open</a></td></tr>`))}</section>
    <section class="section"><div class="sectionHead"><h2>Servers</h2><span class="muted">${data.servers.length}</span></div>${table(['Server','URL','Health',''],data.servers.map(row=>`<tr><td><strong>${esc(row.name)}</strong><div class="subText">${esc(row.slug)}</div></td><td>${esc(row.public_url||row.base_url)}</td><td>${esc(row.health_status)}</td><td><a class="button secondary btn-sm" href="/admin/servers/${esc(row.id)}/edit">Open</a></td></tr>`))}</section>
    <section class="section"><div class="sectionHead"><h2>Provider subscriptions</h2><span class="muted">${data.billing.length}</span></div>${table(['Customer','Provider','Status','Provider ID'],data.billing.map(row=>`<tr><td><a href="/admin/users/${esc(row.customer_id)}">${esc(row.display_name||row.email||'Customer')}</a></td><td>${esc(row.source)}</td><td>${esc(row.status)}</td><td><span class="fingerprint">${esc(row.provider_subscription_id||row.provider_customer_id||'—')}</span></td></tr>`))}</section>`}`;
    return layout({siteName:runtimeSettings.siteName(),active:'search',title:'Search',subtitle:'Customers, resellers, servers and billing identifiers',body});
}

function createAdminSearchRouter(){const r=express.Router();r.use('/admin/search',gate,noStore);r.get('/admin/search',async(req,res,next)=>{try{return res.send(await page(req));}catch(error){next(error);}});return r;}
module.exports={createAdminSearchRouter,results};
