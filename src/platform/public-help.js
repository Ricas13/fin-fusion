'use strict';

const express=require('express');
const runtimeSettings=require('./runtime-settings');
const supportPolicy=require('./support-policy');
const {esc}=require('./admin-html');

function link(label,url,internal=true){return url?`<a class="helpLink" href="${esc(url)}" ${internal?'':'rel="noopener noreferrer"'}><strong>${esc(label)}</strong><span>Open</span></a>`:''}
function render(site,policy={}){
    const contact=policy.supportEmail?`<a href="mailto:${esc(policy.supportEmail)}">${esc(policy.supportEmail)}</a>`:'Use the contact page if you need help before creating an account.';
    const publicLinks=[
        link('Frequently asked questions','/faq'),
        link('Contact','/contact'),
        link('Trust & security','/trust')
    ].join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Help · ${esc(site)}</title><style>body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#0b1220;color:#e5e7eb;min-height:100vh}.wrap{width:min(820px,calc(100% - 32px));margin:0 auto;padding:56px 0}.card{background:#111827;border:1px solid #263244;border-radius:18px;padding:28px;box-sizing:border-box;margin-bottom:18px}.muted{color:#94a3b8;line-height:1.6}a{color:#7dd3fc}.helpGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.helpLink{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:15px 16px;border:1px solid #334155;border-radius:12px;text-decoration:none;background:#0f172a}.helpLink:hover{border-color:#64748b}.accountBox{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}.accountBox p{margin:0;max-width:520px}.button{display:inline-block;padding:12px 16px;border:1px solid #334155;border-radius:10px;text-decoration:none;background:#0f172a}.back{display:inline-block;margin-top:8px}</style></head><body><main class="wrap"><section class="card"><p class="muted" style="margin:0">${esc(site)}</p><h1>Help</h1><p class="muted">A small set of public answers is available here. Detailed setup, service and account guides are available after you sign in.</p><p>${contact}</p></section><section class="card"><h2>Before you join</h2><div class="helpGrid">${publicLinks}</div></section><section class="card accountBox"><p class="muted"><strong style="color:#e5e7eb">Already have an account?</strong><br>Sign in to access the full customer guide and service-specific instructions.</p><a class="button" href="/account/login?next=%2Faccount%2Fdocs">Sign in for full guides →</a></section><a class="back" href="/">← Back to ${esc(site)}</a></main></body></html>`;
}
function createPublicHelpRouter(){const router=express.Router();router.get('/help',async(_req,res,next)=>{try{await runtimeSettings.ensureLoaded();const policy=await supportPolicy.get();res.setHeader('Cache-Control','public, max-age=60');return res.send(render(runtimeSettings.siteName(),policy));}catch(error){return next(error)}});return router;}
module.exports={createPublicHelpRouter,render};
