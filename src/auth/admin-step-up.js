'use strict';
const express=require('express');
const {query}=require('../db');
const auth=require('./service');
const csrf=require('./csrf');
const runtimeSettings=require('../platform/runtime-settings');
const routeRateLimit=require('../security/route-rate-limit');
const WINDOW_MS=Math.max(2,Math.min(30,Number(process.env.ADMIN_STEP_UP_MINUTES||10)))*60*1000;
const MUTATION_PATTERNS=[
 /^\/admin\/customers\/bulk\//,
 // Every per-customer admin mutation is high-impact. Keep this broad so new
 // customer-management child routes cannot silently bypass step-up merely
 // because their action name was not added to a fixed allow-list.
 /^\/admin\/users\/[^/]+(?:\/|$)/,
 /^\/admin\/customer(?:s)?\/[^/]+\//,
 /^\/admin\/plans(?:\/|$)/,
 /^\/admin\/discounts(?:\/|$)/,
 /^\/admin\/referrals(?:\/|$)/,
 /^\/admin\/configuration\/apply$/,
 /^\/admin\/provisioning\/migrations\//,
 /^\/admin\/servers(?:\/|$)/,
 /^\/admin\/provider-mappings(?:\/|$)/,
 /^\/admin\/payments(?:\/|$)/,
 /^\/admin\/commerce\/(?:policy|risk-policy|reconciliation\/|incidents\/[^/]+\/(?:resolve|reopen))/,
 /^\/admin\/backups\/(?:restore|run|verify)/,
 /^\/admin\/settings\/(?:registration|abuse-protection|stremio)(?:\/|$)/,
 /^\/admin\/operations(?:\/|$)/,
 /^\/admin\/security\/2fa-policy$/
];
const stepUpViewLimit=routeRateLimit.middleware({scope:'admin-step-up-view',max:60,windowSeconds:60});
const stepUpVerifyLimit=routeRateLimit.middleware({scope:'admin-step-up-verify',max:8,windowSeconds:600});
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function adminPath(url){return /^\/admin(?:\/|$)/.test(url.pathname);}
function safeNext(req,value){const raw=String(value||'').trim();if(!raw||/[\u0000-\u001f\u007f\\]/.test(raw))return'/admin';try{const fixedBase=new URL('https://captainfin.invalid');const local=new URL(raw,fixedBase);if(raw.startsWith('/')&&local.origin===fixedBase.origin&&adminPath(local))return`${local.pathname}${local.search}${local.hash}`;}catch(_){}try{const absolute=new URL(raw),host=String(req?.get?.('host')||'').trim().toLowerCase();if(host&&absolute.host.toLowerCase()===host&&adminPath(absolute))return`${absolute.pathname}${absolute.search}${absolute.hash}`;}catch(_){}return'/admin';}
async function required(userId){if(!userId)return false;const r=await query(`SELECT totp_enabled FROM app_users WHERE id=$1 AND role='admin' AND active=TRUE`,[userId]);return Boolean(r.rows[0]?.totp_enabled);}
function fresh(req){return Number.isFinite(Number(req.session?.adminStepUpAt))&&Date.now()-Number(req.session.adminStepUpAt)<=WINDOW_MS;}
function sensitive(req){return req.method==='POST'&&MUTATION_PATTERNS.some(re=>re.test(req.path||req.originalUrl||''));}
function page(req,error=null){const next=safeNext(req,req.query.next||req.session?.adminStepUpNext||'/admin');return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Security confirmation · ${esc(runtimeSettings.siteName())}</title><link rel="stylesheet" href="/css/admin-original-base.css"><link rel="stylesheet" href="/css/admin-original-components.css"><style>main{max-width:580px;margin:48px auto;padding:22px}.panel{padding:22px}.field{margin:16px 0}</style></head><body><main><p><a href="${esc(next)}">← Back</a></p><section class="panel"><h1>Security confirmation</h1><p>This action changes customer access, billing, infrastructure or security-sensitive configuration. Enter your authenticator or recovery code once; high-impact actions remain unlocked for ${Math.round(WINDOW_MS/60000)} minutes.</p>${error?`<div class="notice error">${esc(error)}</div>`:''}<form method="post" action="/admin/security/step-up"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><input type="hidden" name="next" value="${esc(next)}"><div class="field"><label>Authenticator or recovery code</label><input class="input" name="code" autocomplete="one-time-code" required autofocus></div><button class="button">Confirm</button></form><p class="muted">If you arrived here after submitting a form, verify and then submit that action again. The original mutation was not executed.</p></section></main></body></html>`;}
function createAdminStepUpRouter(){const r=express.Router();r.get('/admin/security/step-up',stepUpViewLimit,async(req,res,next)=>{try{if(req.session?.authRole!=='admin'||!req.session?.authUserId)return res.redirect('/login?session=expired');await runtimeSettings.ensureLoaded();if(!(await required(req.session.authUserId)))return res.redirect(safeNext(req,req.query.next));return res.send(page(req));}catch(e){next(e)}});r.post('/admin/security/step-up',stepUpVerifyLimit,async(req,res,next)=>{try{if(req.session?.authRole!=='admin'||!req.session?.authUserId)return res.redirect('/login?session=expired');if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');await runtimeSettings.ensureLoaded();if(!(await required(req.session.authUserId))){req.session.adminStepUpAt=Date.now();return res.redirect(safeNext(req,req.body.next));}const ok=await auth.verifySecondFactor(req.session.authUserId,req.body.code,req);if(!ok)return res.status(401).send(page(req,'Authenticator or recovery code was not accepted.'));req.session.adminStepUpAt=Date.now();req.session.adminStepUpNext=null;await new Promise((resolve,reject)=>req.session.save(e=>e?reject(e):resolve()));return res.redirect(safeNext(req,req.body.next));}catch(e){next(e)}});return r;}
async function sensitiveMutationGuard(req,res,next){try{if(!sensitive(req)||req.session?.authRole!=='admin'||!req.session?.authUserId)return next();if(!(await required(req.session.authUserId)))return next();if(fresh(req))return next();const referer=safeNext(req,req.get('referer')||'/admin');req.session.adminStepUpNext=referer;await new Promise((resolve,reject)=>req.session.save(e=>e?reject(e):resolve()));return res.redirect(303,'/admin/security/step-up?next='+encodeURIComponent(referer));}catch(e){next(e)}}
module.exports={WINDOW_MS,MUTATION_PATTERNS,required,fresh,sensitive,safeNext,createAdminStepUpRouter,sensitiveMutationGuard};