'use strict';

const express=require('express');
const {query}=require('../db');
const runtimeSettings=require('./runtime-settings');
const {layout,esc}=require('./admin-html');
function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired')}
function noStore(_q,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next()}
function dt(v){return v?new Date(v).toLocaleString('en-GB'):'—'}
function clean(v,n=100){return String(v||'').trim().slice(0,n)}
function metadata(value){if(!value)return'';try{const text=typeof value==='string'?value:JSON.stringify(value);return text.length>260?text.slice(0,257)+'…':text}catch{return''}}
async function timeline({type='',q='',limit=250}={}){
 const n=Math.max(25,Math.min(500,Number(limit)||250));
 const [audit,auth,payments,provisioning,email]=await Promise.all([
  query(`SELECT created_at AS at,'audit' kind,action title,entity_type subject,entity_id::text subject_id,metadata detail FROM audit_log ORDER BY created_at DESC LIMIT $1`,[n]),
  query(`SELECT created_at AS at,'security' kind,event_type title,COALESCE(identity_hint,'user') subject,user_id::text subject_id,jsonb_build_object('success',success) detail FROM auth_events ORDER BY created_at DESC LIMIT $1`,[n]),
  query(`SELECT created_at AS at,'payment' kind,event_type title,provider subject,provider_event_id subject_id,jsonb_build_object('processedAt',processed_at,'error',processing_error) detail FROM payment_events ORDER BY created_at DESC LIMIT $1`,[n]),
  query(`SELECT updated_at AS at,'provisioning' kind,'provisioning.'||status title,status subject,customer_id::text subject_id,jsonb_build_object('attempts',attempt_count,'failures',consecutive_failures,'lastError',last_error,'serverId',server_id,'lastResult',last_result) detail FROM customer_provisioning_state ORDER BY updated_at DESC LIMIT $1`,[n]),
  query(`SELECT COALESCE(sent_at,last_attempt_at,created_at) AS at,'email' kind,message_type title,status subject,id::text subject_id,jsonb_build_object('recipient',recipient_email,'attempts',attempts,'error',last_error) detail FROM notification_outbox ORDER BY COALESCE(sent_at,last_attempt_at,created_at) DESC LIMIT $1`,[n])
 ]);
 let rows=[...audit.rows,...auth.rows,...payments.rows,...provisioning.rows,...email.rows].sort((a,b)=>new Date(b.at)-new Date(a.at));
 if(type)rows=rows.filter(r=>r.kind===type);
 if(q){const needle=q.toLowerCase();rows=rows.filter(r=>[r.kind,r.title,r.subject,r.subject_id,metadata(r.detail)].join(' ').toLowerCase().includes(needle));}
 return rows.slice(0,n);
}
async function page(req){await runtimeSettings.ensureLoaded();const type=clean(req.query.type,30),q=clean(req.query.q,100);const rows=await timeline({type,q});const kinds=['','audit','security','payment','provisioning','email'];const body=`<form class="formPanel" method="get" action="/admin/events"><div class="formGrid"><div class="formGroup"><label>Type</label><select class="input" name="type">${kinds.map(k=>`<option value="${esc(k)}" ${k===type?'selected':''}>${esc(k||'All events')}</option>`).join('')}</select></div><div class="formGroup"><label>Search</label><input class="input" name="q" value="${esc(q)}" placeholder="Action, customer ID, provider ID, error…"></div></div><button class="button secondary">Filter</button></form><section class="section"><div class="sectionHead"><h2>Timeline</h2><span class="muted">${rows.length} newest matching events</span></div>${rows.length?`<div class="timelineList">${rows.map(row=>`<div class="timelineItem"><div class="timelineTime">${esc(dt(row.at))}</div><div><div class="timelineTitle"><span class="pill">${esc(row.kind)}</span> ${esc(row.title)}</div><div class="timelineDetail">${esc(row.subject||'')}${row.subject_id?' · '+esc(row.subject_id):''}${metadata(row.detail)?' · '+esc(metadata(row.detail)):''}</div></div></div>`).join('')}</div>`:'<div class="empty">No matching events.</div>'}</section>`;return layout({siteName:runtimeSettings.siteName(),active:'events',title:'Events',subtitle:'Security, billing, provisioning, email and administration in one timeline',body});}
function createAdminEventsRouter(){const r=express.Router();r.use('/admin/events',gate,noStore);r.get('/admin/events',async(req,res,next)=>{try{return res.send(await page(req))}catch(e){next(e)}});return r}
module.exports={createAdminEventsRouter,timeline};
