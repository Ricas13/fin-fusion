'use strict';

const express=require('express');
const {query}=require('../db');
const runtimeSettings=require('./runtime-settings');
const readCursors=require('./operator-read-cursors');
const {esc,layout}=require('./admin-html');
const ui=require('./admin-ui');

const ORDERS_PATH='/admin/commerce/orders';
const LEGACY_ORDERS_PATH='/admin/orders';
function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
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
function statusKind(status){return status==='past_due'?'warn':['active','trialing'].includes(status)?'good':['cancelled','expired'].includes(status)?'bad':'';}
function orderTable(orders){
 if(!orders.length)return'<div class="empty">No provider orders yet.</div>';
 return `<div class="tableWrap"><table class="dataTable responsiveTable ordersTable"><caption class="srOnly">Stripe and PayPal purchase history</caption><thead><tr><th>Date</th><th>Customer</th><th>Plan</th><th>Provider</th><th>Status</th></tr></thead><tbody>${orders.map(row=>{const customer=row.display_name||row.customer_username||row.customer_email||row.customer_id;return `<tr><td data-label="Date">${esc(when(row.created_at))}</td><td data-label="Customer"><a class="mediaTitle" href="/admin/users/${esc(row.customer_id)}?tab=billing">${esc(customer)}</a><div class="subText">Open customer billing →</div></td><td data-label="Plan">${esc(row.plan_name||row.plan_code||'Plan')}</td><td data-label="Provider"><span class="pill ${row.source==='stripe'?'accent':''}">${esc(row.source==='stripe'?'Stripe':'PayPal')}</span></td><td data-label="Status"><span class="pill ${statusKind(row.status)}">${esc(row.status)}</span></td></tr>`}).join('')}</tbody></table></div>`;
}
function ordersHero(orders){
 const recentCutoff=Date.now()-30*24*60*60*1000,recent=orders.filter(row=>new Date(row.created_at).getTime()>=recentCutoff),attention=orders.filter(row=>row.status==='past_due'),stripe=recent.filter(row=>row.source==='stripe').length,paypal=recent.filter(row=>row.source==='paypal').length;
 const tone=attention.length?'warn':'commerce',title=attention.length?`${attention.length} purchased subscription ${attention.length===1?'needs':'need'} billing attention`:(recent.length?`${recent.length} provider ${recent.length===1?'purchase':'purchases'} in the last 30 days`:'No recent provider purchases');
 const next=attention.length?'Open the first past-due customer and resolve billing before reviewing routine purchase history.':'No order intervention is required; use this page to trace purchases back to the customer account.';
 const first=attention[0];
 return ui.operatorHero({tone,eyebrow:'Transaction desk',title,body:'Orders is the purchase trail for Stripe and PayPal. It links transactions to the customer billing journey instead of exposing internal subscription records as the primary experience.',statusLabel:attention.length?'Review needed':'Transactions clear',next,facts:[{label:'Last 30 days',value:String(recent.length),detail:'provider purchases'},{label:'Stripe',value:String(stripe),detail:'last 30 days'},{label:'PayPal',value:String(paypal),detail:'last 30 days'},{label:'Past due',value:String(attention.length),detail:'within loaded purchase history'}],actionsHtml:first?`<a class="button" href="/admin/users/${encodeURIComponent(first.customer_id)}?tab=billing">Review first past-due customer</a><a class="button secondary" href="/admin/billing">Billing operations</a>`:'<a class="button secondary" href="/admin/billing">Billing operations</a><a class="button secondary" href="/admin/payments">Payment providers</a>'});
}
async function page(){await runtimeSettings.ensureLoaded();const orders=await rows(),recent=orders.slice(0,25),body=`${ordersHero(orders)}<section class="section">${ui.sectionHeader({title:'Recent purchases',description:'Newest Stripe and PayPal purchases. Select a customer to continue in their Billing journey.'})}${orderTable(recent)}${orders.length>recent.length?ui.detailDisclosure({title:`Full purchase history (${orders.length})`,summary:'Older provider purchases · open only when tracing a historical transaction',bodyHtml:orderTable(orders)}):''}</section>`;return layout({siteName:runtimeSettings.siteName(),active:'orders',title:'Orders',subtitle:'Trace purchases to customers; handle recurring billing problems in Billing',body});}
async function markOrdersSeen(req){
 try{return await readCursors.markSeen(req.session.authUserId,'orders');}
 catch(error){console.warn('Order read cursor update failed:',error.message);return null;}
}
function createAdminOrdersRouter(){
 const router=express.Router();
 router.use('/admin/commerce/orders',gate,noStore);
 router.use('/admin/orders',gate,noStore);
 router.get('/admin/commerce/orders',async(req,res,next)=>{try{const html=await page();await markOrdersSeen(req);return res.send(html)}catch(error){next(error)}});
 router.get('/admin/orders',(_req,res)=>res.redirect(308,ORDERS_PATH));
 return router;
}
module.exports={createAdminOrdersRouter,page,rows,orderTable,ordersHero,markOrdersSeen,ORDERS_PATH,LEGACY_ORDERS_PATH};
