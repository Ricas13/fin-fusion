'use strict';

const express=require('express');
const {query}=require('../db');
const runtimeSettings=require('./runtime-settings');
const {esc,layout}=require('./admin-html');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'?next():res.redirect('/login?session=expired');}
function when(value){try{return new Date(value).toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short'})}catch{return String(value||'—')}}
async function rows(){return(await query(`SELECT s.id,s.customer_id,s.status,s.source,s.created_at,
 COALESCE(NULLIF(s.plan_name_snapshot,''),p.name) plan_name,
 COALESCE(NULLIF(s.plan_code_snapshot,''),p.code) plan_code,
 c.display_name,
 COALESCE(NULLIF(c.email,''),NULLIF(u.email,'')) customer_email,
 u.username customer_username
 FROM subscriptions s
 JOIN customers c ON c.id=s.customer_id
 LEFT JOIN app_users u ON u.id=c.user_id
 LEFT JOIN plans p ON p.id=s.plan_id
 WHERE s.source IN ('stripe','paypal') ORDER BY s.created_at DESC LIMIT 500`)).rows;}
async function page(){await runtimeSettings.ensureLoaded();const orders=await rows();const body=`<div class="statusBanner"><strong>Orders:</strong> Stripe and PayPal subscription purchases. Free/manual grants are kept out of this operator view.</div><section class="section"><div class="sectionHead"><div><h2>Recent orders</h2><div class="muted">${orders.length} most recent provider subscription records</div></div></div>${orders.length?`<div class="table"><div class="tableHead" style="grid-template-columns:140px minmax(190px,1.4fr) minmax(180px,1fr) 110px 120px"><span>Date</span><span>Customer</span><span>Plan</span><span>Provider</span><span>Status</span></div>${orders.map(row=>{const customer=row.display_name||row.customer_username||row.customer_email||row.customer_id;return `<a class="tableRow" href="/admin/users/${esc(row.customer_id)}" style="grid-template-columns:140px minmax(190px,1.4fr) minmax(180px,1fr) 110px 120px;text-decoration:none;color:inherit"><span>${esc(when(row.created_at))}</span><span><strong>${esc(customer)}</strong></span><span>${esc(row.plan_name||row.plan_code||'Plan')}</span><span>${esc(row.source)}</span><span><span class="pill ${row.status==='past_due'?'bad':'good'}">${esc(row.status)}</span></span></a>`}).join('')}</div>`:'<div class="empty">No provider orders yet.</div>'}</section>`;return layout({siteName:runtimeSettings.siteName(),active:'orders',title:'Orders',subtitle:'Recent customer purchases',body});}
function createAdminOrdersRouter(){const router=express.Router();router.use('/admin/orders',gate);router.get('/admin/orders',async(_req,res,next)=>{try{return res.send(await page())}catch(error){next(error)}});return router;}
module.exports={createAdminOrdersRouter,page,rows};
