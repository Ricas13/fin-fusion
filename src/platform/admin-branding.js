'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const branding = require('./branding');
const runtimeSettings = require('./runtime-settings');
const { layout, esc } = require('./admin-html');

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}

async function preview(kind, fallbackLabel) {
    const meta = await branding.metadata(kind);
    const custom = Boolean(meta);
    const src = branding.assetUrl(kind) + (custom && meta.sha256 ? `?v=${encodeURIComponent(String(meta.sha256).slice(0,12))}` : '');
    const source = meta?.source === 'database'
        ? `Stored in PostgreSQL · ${Number(meta.size_bytes || 0).toLocaleString('en-GB')} bytes`
        : meta?.source === 'legacy_file'
            ? 'Legacy file detected; it will be imported into PostgreSQL automatically.'
            : 'Upload a custom file to override the bundled default.';
    return `<div class="brandAssetPreview"><img src="${esc(src)}" alt="${esc(fallbackLabel)} preview"><div><strong>${custom ? 'Custom asset active' : 'Using default asset'}</strong><div class="muted">${esc(source)}</div></div></div>`;
}

async function uploadBlock(req, kind, title, hint, accept) {
    const max = kind === 'logo' ? '1 MB' : '256 KB';
    const meta = await branding.metadata(kind);
    return `<section class="settings-card"><div class="card-header"><div><h3>${esc(title)}</h3><div class="settings-hint">${esc(hint)} · Maximum ${esc(max)}</div></div></div><div class="card-body">${await preview(kind,title)}<div class="formGroup"><label>Select file</label><input class="input brandFile" id="${esc(kind)}File" type="file" accept="${esc(accept)}"></div><div class="quick-actions"><button type="button" class="button" data-brand-upload="${esc(kind)}">Upload ${esc(title.toLowerCase())}</button>${meta?`<form method="post" action="/admin/settings/branding/${esc(kind)}/remove" style="display:inline"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><button type="submit" class="button secondary">Reset to default</button></form>`:''}</div><div class="settings-hint" id="${esc(kind)}Status" style="margin-top:10px"></div></div></section>`;
}

async function page(req) {
    await runtimeSettings.ensureLoaded();
    const csrfValue = csrf.token(req);
    const blocks = await Promise.all([
        uploadBlock(req,'logo','Logo','PNG, JPEG or WebP','image/png,image/jpeg,image/webp'),
        uploadBlock(req,'favicon','Favicon','PNG or ICO','image/png,image/x-icon,image/vnd.microsoft.icon,.ico')
    ]);
    const body = `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}<div class="statusBanner"><strong>Shared branding storage:</strong> custom logo and favicon data is stored in PostgreSQL so every application replica serves the same assets. Existing legacy files are imported automatically on first use.</div><div class="settings-grid">${blocks.join('')}</div><script>(function(){const token=${JSON.stringify(csrfValue)};document.querySelectorAll('[data-brand-upload]').forEach(btn=>btn.addEventListener('click',async()=>{const kind=btn.dataset.brandUpload,file=document.getElementById(kind+'File').files[0],status=document.getElementById(kind+'Status');if(!file){status.textContent='Choose a file first.';return;}btn.disabled=true;status.textContent='Uploading…';try{const response=await fetch('/admin/settings/branding/'+kind,{method:'POST',credentials:'same-origin',headers:{'Content-Type':file.type||'application/octet-stream','X-CSRF-Token':token},body:file});const result=await response.json().catch(()=>({ok:false,error:'Unexpected server response.'}));if(!response.ok||!result.ok)throw new Error(result.error||'Upload failed.');location.reload();}catch(error){status.textContent=error.message;}finally{btn.disabled=false;}}));})();</script>`;
    return layout({ siteName: runtimeSettings.siteName(), active: 'branding', title: 'Branding', subtitle: 'Shared logo and browser icon used across CAPTaINFiN', body });
}

function createAdminBrandingRouter() {
    const r = express.Router();
    r.get('/admin/settings/branding', gate, async (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store, private, max-age=0');
        try { return res.send(await page(req)); }
        catch (error) { return next(error); }
    });
    return r;
}

module.exports = { createAdminBrandingRouter, page };
