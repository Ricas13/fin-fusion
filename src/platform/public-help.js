'use strict';

const express=require('express');
const runtimeSettings=require('./runtime-settings');
const supportPolicy=require('./support-policy');
const {esc}=require('./admin-html');

function link(label,url){return url?`<a class="helpLink" href="${esc(url)}" rel="noopener noreferrer"><strong>${esc(label)}</strong><span>Open</span></a>`:''}
function render(site,policy){
    const contact=policy.supportEmail?`<a href="mailto:${esc(policy.supportEmail)}">${esc(policy.supportEmail)}</a>`:'Support contact has not been published yet.';
    const links=[link('Help & guides',policy.docsUrl),link('Support',policy.supportUrl),link('Service status',policy.statusUrl),link('Terms of service',policy.termsUrl),link('Privacy policy',policy.privacyUrl),link('Refund policy',policy.refundPolicyUrl)].filter(Boolean).join('');
    const company=[policy.companyName,policy.companyAddress,policy.companyTaxId].filter(Boolean);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Help · ${esc(site)}</title><style>body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#0b1220;color:#e5e7eb;min-height:100vh}.wrap{width:min(820px,calc(100% - 32px));margin:0 auto;padding:56px 0}.card{background:#111827;border:1px solid #263244;border-radius:18px;padding:28px;box-sizing:border-box;margin-bottom:18px}.muted{color:#94a3b8;line-height:1.6}a{color:#7dd3fc}.helpGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.helpLink{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:15px 16px;border:1px solid #334155;border-radius:12px;text-decoration:none;background:#0f172a}.helpLink:hover{border-color:#64748b}.back{display:inline-block;margin-top:8px}</style></head><body><main class="wrap"><section class="card"><p class="muted" style="margin:0">${esc(site)}</p><h1>Help & support</h1><p class="muted">Find guides, support contact details, service status and the policies published by this service.</p><p>${contact}</p></section>${links?`<section class="card"><h2>Guides, support & policies</h2><div class="helpGrid">${links}</div></section>`:''}${company.length?`<section class="card"><h2>Service operator</h2>${company.map(value=>`<p class="muted">${esc(value)}</p>`).join('')}</section>`:''}<a class="back" href="/">← Back to ${esc(site)}</a></main></body></html>`;
}
function createPublicHelpRouter(){const router=express.Router();router.get('/help',async(_req,res,next)=>{try{await runtimeSettings.ensureLoaded();const policy=await supportPolicy.get();res.setHeader('Cache-Control','public, max-age=60');return res.send(render(runtimeSettings.siteName(),policy));}catch(error){return next(error)}});return router;}
module.exports={createPublicHelpRouter,render};
