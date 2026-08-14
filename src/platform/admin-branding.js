'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const branding = require('./branding');
const { layout, esc } = require('./admin-html');

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}

function preview(kind, fallbackLabel) {
    const custom = Boolean(branding.existing(kind));
    const src = branding.assetUrl(kind) + (custom ? `?v=${Date.now()}` : '');
    return `<div class="brandAssetPreview"><img src="${esc(src)}" alt="${esc(fallbackLabel)} preview"><div><strong>${custom ? 'Custom asset active' : 'Using default asset'}</strong><div class="muted">${custom ? 'Stored on the persistent application volume.' : 'Upload a custom file to override the bundled default.'}</div></div></div>`;
}

function uploadBlock(req, kind, title, hint, accept) {
    const max = kind === 'logo' ? '1 MB' : '256 KB';
    return `<section class="settings-card"><div class="card-header"><div><h3>${esc(title)}</h3><div class="settings-hint">${esc(hint)} · Maximum ${esc(max)}</div></div></div><div class="card-body">${preview(kind,title)}<div class="formGroup"><label>Select file</label><input class="input brandFile" id="${esc(kind)}File" type="file" accept="${esc(accept)}"></div><div class="formGroup"><label>Authenticator / recovery code <span class="muted">(only needed if 2FA is enabled)</span></label><input class="input" id="${esc(kind)}Code" autocomplete="one-time-code"></div><div class="quick-actions"><button type="button" class="button" data-brand-upload="${esc(kind)}">Upload ${esc(title.toLowerCase())}</button>${branding.existing(kind)?`<form method="post" action="/admin/settings/branding/${esc(kind)}/remove" style="display:inline"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><input type="hidden" name="code" id="${esc(kind)}RemoveCode"><button type="submit" class="button secondary" data-brand-remove="${esc(kind)}">Reset to default</button></form>`:''}</div><div class="settings-hint" id="${esc(kind)}Status" style="margin-top:10px"></div></div></section>`;
}

function page(req) {
    const csrfValue = csrf.token(req);
    const body = `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}<div class="settings-grid">${uploadBlock(req,'logo','Logo','PNG, JPEG or WebP','image/png,image/jpeg,image/webp')}${uploadBlock(req,'favicon','Favicon','PNG or ICO','image/png,image/x-icon,image/vnd.microsoft.icon,.ico')}</div><script>(function(){const token=${JSON.stringify(csrfValue)};document.querySelectorAll('[data-brand-remove]').forEach(btn=>{btn.closest('form').addEventListener('submit',()=>{const kind=btn.dataset.brandRemove;document.getElementById(kind+'RemoveCode').value=document.getElementById(kind+'Code').value;});});document.querySelectorAll('[data-brand-upload]').forEach(btn=>btn.addEventListener('click',async()=>{const kind=btn.dataset.brandUpload,file=document.getElementById(kind+'File').files[0],status=document.getElementById(kind+'Status'),code=document.getElementById(kind+'Code').value;if(!file){status.textContent='Choose a file first.';return;}btn.disabled=true;status.textContent='Uploading…';try{const response=await fetch('/admin/settings/branding/'+kind,{method:'POST',credentials:'same-origin',headers:{'Content-Type':file.type||'application/octet-stream','X-CSRF-Token':token,'X-2FA-Code':code},body:file});const result=await response.json().catch(()=>({ok:false,error:'Unexpected server response.'}));if(!response.ok||!result.ok)throw new Error(result.error||'Upload failed.');location.reload();}catch(error){status.textContent=error.message;}finally{btn.disabled=false;}}));})();</script>`;
    return layout({ siteName: process.env.SITE_NAME || 'CAPTAiNFiN', active: 'branding', title: 'Branding', subtitle: 'Logo and browser icon used across CAPTAiNFiN', body });
}

function createAdminBrandingRouter() {
    const r = express.Router();
    r.get('/admin/settings/branding', gate, (req, res) => {
        res.setHeader('Cache-Control', 'no-store, private, max-age=0');
        return res.send(page(req));
    });
    return r;
}

module.exports = { createAdminBrandingRouter };
