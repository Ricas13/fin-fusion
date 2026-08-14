'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const claims = require('../customer-claims');
const runtimeSettings = require('./runtime-settings');
const branding = require('./branding');
const { esc, layout } = require('./admin-html');

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}
function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}
function absoluteUrl(req, path) {
    const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
    const proto = forwardedProto || req.protocol;
    const host = req.get('x-forwarded-host') || req.get('host');
    return `${proto}://${host}${path}`;
}
function date(value) {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
function notice(req) {
    return `${req.query.message ? `<div class="notice success">${esc(req.query.message)}</div>` : ''}${req.query.error ? `<div class="notice error">${esc(req.query.error)}</div>` : ''}`;
}
function csrfInput(req) { return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`; }
function pill(label, kind = '') { return `<span class="pill ${kind}">${esc(label)}</span>`; }

function adminStatus(row) {
    if (row.user_id) return pill('Claimed', 'good');
    if (!row.claim_id) return pill('No link');
    if (row.claim_status === 'active') return pill('Active link', 'accent');
    if (row.claim_status === 'expired') return pill('Expired', 'warn');
    if (row.claim_status === 'revoked') return pill('Revoked', 'bad');
    if (row.claim_status === 'claimed') return pill('Claimed', 'good');
    return pill(row.claim_status || 'Unknown');
}

function createForm(req, row) {
    return `<form method="post" action="/admin/customer-claims/${esc(row.customer_id)}/create" class="claimCreate" data-native-submit="true">
        ${csrfInput(req)}
        <select class="input compact" name="ttlHours" aria-label="Claim link expiry">
            <option value="24">1 day</option><option value="72">3 days</option><option value="168" selected>7 days</option><option value="336">14 days</option><option value="720">30 days</option>
        </select>
        <input class="input compact" type="email" name="emailLock" maxlength="254" value="${esc(row.email || '')}" placeholder="Email lock (optional)" aria-label="Optional email lock">
        <button class="button btn-sm" type="submit">${row.claim_status === 'active' ? 'Rotate link' : 'Create link'}</button>
    </form>`;
}

function adminRow(req, row) {
    const activeUrl = row.claim_status === 'active' && row.raw_token
        ? absoluteUrl(req, `/claim/${encodeURIComponent(row.raw_token)}`)
        : null;
    const identity = row.jellyfin_usernames || row.display_name || 'Imported customer';
    const action = row.user_id
        ? `<a class="button secondary btn-sm" href="/admin/users/${esc(row.customer_id)}">Open customer</a>`
        : `<div class="claimActions">${activeUrl ? `<button type="button" class="button btn-sm" data-copy-link="${esc(activeUrl)}">Copy link</button>` : ''}${row.claim_status === 'active' ? `<form method="post" action="/admin/customer-claims/${esc(row.claim_id)}/revoke">${csrfInput(req)}<button class="button secondary btn-sm" type="submit">Revoke</button></form>` : ''}</div>${createForm(req, row)}`;
    return `<tr>
        <td>${adminStatus(row)}</td>
        <td><strong>${esc(identity)}</strong><div class="subText">${esc(row.display_name || '')}</div></td>
        <td>${esc(row.server_names || '—')}</td>
        <td>${row.user_id ? `<strong>${esc(row.portal_username || 'Portal account')}</strong><div class="subText">Last login ${esc(date(row.last_login_at))}</div>` : '<span class="muted">Unclaimed</span>'}</td>
        <td>${row.claim_id ? `<div>${esc(date(row.expires_at))}</div>${row.email_lock ? `<div class="subText">Locked to ${esc(row.email_lock)}</div>` : '<div class="subText">Any holder of the link</div>'}` : '—'}</td>
        <td class="right">${action}</td>
    </tr>`;
}

async function adminPage(req) {
    await runtimeSettings.ensureLoaded();
    const rows = await claims.listAdminClaims();
    const unclaimed = rows.filter(row => !row.user_id).length;
    const activeLinks = rows.filter(row => !row.user_id && row.claim_status === 'active').length;
    const claimed = rows.filter(row => row.user_id).length;
    const body = `${notice(req)}
        <div class="metrics"><div class="metric"><div class="metricLabel">Unclaimed</div><div class="metricValue smallish">${unclaimed}</div></div><div class="metric"><div class="metricLabel">Active links</div><div class="metricValue smallish">${activeLinks}</div></div><div class="metric"><div class="metricLabel">Claimed</div><div class="metricValue smallish">${claimed}</div></div></div>
        <section class="section"><div class="sectionHead"><div><h2>Imported customer claims</h2><div class="muted">Give an existing Jellyfin user a CAPTaINFiN portal login without recreating the Jellyfin user or changing their Jellyfin password.</div></div><span class="muted">${rows.length} imported customers</span></div>
        ${rows.length ? `<div class="tableWrap"><table class="dataTable claimTable"><thead><tr><th>Status</th><th>Jellyfin user</th><th>Server</th><th>Portal</th><th>Claim link</th><th class="right">Actions</th></tr></thead><tbody>${rows.map(row => adminRow(req, row)).join('')}</tbody></table></div>` : '<div class="empty">No imported Jellyfin customers are available yet. Import users first from People → Jellyfin Import.</div>'}</section>
        <div class="notice">Claim links authorize creation of the CAPTaINFiN portal identity only. Existing Jellyfin passwords and policies are not modified during claim.</div>
        <style>.claimTable{min-width:1180px}.claimCreate{display:grid;grid-template-columns:105px minmax(180px,1fr) auto;gap:6px;margin-top:7px}.claimActions{display:flex;justify-content:flex-end;gap:6px}.claimActions form{margin:0}.metricValue.smallish{font-size:22px}@media(max-width:760px){.claimCreate{grid-template-columns:1fr}.claimTable{min-width:1000px}}</style>
        <script>(function(){document.querySelectorAll('[data-copy-link]').forEach(function(button){button.addEventListener('click',async function(){var value=button.getAttribute('data-copy-link');try{await navigator.clipboard.writeText(value);var old=button.textContent;button.textContent='Copied';setTimeout(function(){button.textContent=old},1400)}catch(_){window.prompt('Copy claim link',value)}})})})();</script>`;
    return layout({
        siteName: runtimeSettings.siteName(),
        active: 'customer-claims',
        title: 'Customer Claims',
        subtitle: 'Let imported Jellyfin users securely claim their CAPTaINFiN portal identity',
        body,
        action: '<a class="button secondary" href="/admin/jellyfin-import">Import from Jellyfin</a>'
    });
}

function publicShell(title, body) {
    const site = runtimeSettings.siteName();
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${esc(title)} · ${esc(site)}</title><link rel="icon" href="${esc(branding.assetUrl('favicon'))}"><style>
        *{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#0d1117;color:#e8edf3;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.claimPage{width:min(650px,calc(100% - 28px));margin:0 auto;padding:34px 0 56px}.brand{display:flex;align-items:center;gap:10px;color:#eef4f8;text-decoration:none;font-weight:800;margin-bottom:26px}.brand img{width:38px;height:38px;border-radius:9px;object-fit:cover}.card{background:#151b22;border:1px solid #2b3440;border-radius:12px;padding:22px;box-shadow:0 18px 55px rgba(0,0,0,.24)}h1{font-size:25px;margin:0 0 7px}.lead{color:#8f9cad;line-height:1.55;margin:0 0 20px}.identity{padding:13px 14px;background:#10161d;border:1px solid #28313b;border-radius:8px;margin-bottom:19px}.identity strong{display:block;font-size:15px}.identity small{display:block;color:#748295;margin-top:4px}.field{display:grid;gap:5px;margin-bottom:12px}.field label{font-size:11px;color:#9aa7b6;font-weight:700}.input{width:100%;min-height:42px;padding:9px 10px;border:1px solid #343e49;border-radius:7px;background:#0f151b;color:#e8edf3;font-size:14px}.input[readonly]{color:#aab5c1;background:#12171d}.help{font-size:10px;color:#748295;line-height:1.45}.button{width:100%;min-height:43px;border:1px solid #2d6474;border-radius:7px;background:#163844;color:#ecfbff;font-weight:800;cursor:pointer}.notice{padding:10px 12px;margin:0 0 15px;border-radius:7px;border:1px solid rgba(216,90,97,.26);background:rgba(216,90,97,.08);color:#f1a2a7;font-size:12px}.safe{border-color:rgba(59,196,129,.25);background:rgba(59,196,129,.07);color:#9ae2bd}.footer{text-align:center;color:#657386;font-size:10px;margin-top:16px}@media(max-width:520px){.claimPage{padding-top:20px}.card{padding:17px}}
    </style></head><body><main class="claimPage"><a class="brand" href="/"><img src="${esc(branding.assetUrl('logo'))}" alt=""><span>${esc(site)}</span></a>${body}<div class="footer">Secure existing-account claim</div></main></body></html>`;
}

function unavailable(message) {
    return publicShell('Claim unavailable', `<section class="card"><h1>Claim link unavailable</h1><p class="lead">${esc(message)}</p><a href="/account/login" style="color:#72cce7">Customer sign in</a></section>`);
}

function publicForm(req, claim, values = {}, error = null) {
    const suggested = values.username || claim.suggested_username || '';
    const emailField = claim.email_lock
        ? `<div class="field"><label>Email</label><input class="input" type="email" name="email" value="${esc(claim.email_lock)}" readonly><div class="help">This claim was locked to this email by the administrator.</div></div>`
        : `<div class="field"><label>Email <span class="help">(optional)</span></label><input class="input" type="email" name="email" maxlength="254" autocomplete="email" value="${esc(values.email || claim.customer_email || '')}"><div class="help">Optional. You can sign in with the portal username even without an email.</div></div>`;
    return publicShell('Claim your account', `<section class="card"><h1>Claim your account</h1><p class="lead">Your existing Jellyfin account is already connected to ${esc(runtimeSettings.siteName())}. Create the portal login you will use to manage it.</p>${error ? `<div class="notice">${esc(error)}</div>` : ''}<div class="identity"><strong>${esc(claim.jellyfin_usernames || claim.display_name || 'Existing Jellyfin account')}</strong><small>${esc(claim.server_names || '')} · claim expires ${esc(date(claim.expires_at))}</small></div><div class="notice safe">Your current Jellyfin password will not be changed by this claim. This password is for the CAPTaINFiN portal.</div><form method="post" action="/claim/${encodeURIComponent(req.params.token)}"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">${emailField}<div class="field"><label>Portal username</label><input class="input" name="username" minlength="3" maxlength="40" pattern="[A-Za-z0-9._-]{3,40}" autocomplete="username" required value="${esc(suggested)}"><div class="help">You can keep the same username as Jellyfin or choose another portal username.</div></div><div class="field"><label>Portal password</label><input class="input" type="password" name="password" minlength="12" maxlength="200" autocomplete="new-password" required><div class="help">At least 12 characters. This does not replace your existing Jellyfin password.</div></div><div class="field"><label>Confirm portal password</label><input class="input" type="password" name="confirmPassword" minlength="12" maxlength="200" autocomplete="new-password" required></div><button class="button" type="submit">Claim account</button></form></section>`);
}

function statusMessage(claim) {
    if (!claim) return 'This claim link is invalid.';
    if (claim.status === 'claimed') return 'This customer account has already been claimed.';
    if (claim.status === 'revoked') return 'This claim link has been revoked.';
    if (claim.status === 'expired') return 'This claim link has expired.';
    return 'This claim link is no longer available.';
}

function createCustomerClaimRouter() {
    const router = express.Router();

    router.use('/claim', noStore);
    router.get('/claim/:token', async (req, res, next) => {
        try {
            await runtimeSettings.ensureLoaded();
            const claim = await claims.lookupClaim(req.params.token);
            if (!claim) return res.status(404).send(unavailable(statusMessage(null)));
            if (claim.status !== 'active') return res.status(410).send(unavailable(statusMessage(claim)));
            return res.send(publicForm(req, claim));
        } catch (error) { return next(error); }
    });
    router.post('/claim/:token', async (req, res, next) => {
        try {
            await runtimeSettings.ensureLoaded();
            const claim = await claims.lookupClaim(req.params.token);
            if (!claim) return res.status(404).send(unavailable(statusMessage(null)));
            if (claim.status !== 'active') return res.status(410).send(unavailable(statusMessage(claim)));
            if (!csrf.verify(req)) return res.status(403).send(publicForm(req, claim, req.body, 'Your form expired. Please try again.'));
            if (String(req.body.password || '') !== String(req.body.confirmPassword || '')) return res.status(400).send(publicForm(req, claim, req.body, 'Passwords do not match.'));
            let redeemed;
            try {
                redeemed = await claims.redeemClaim({ token: req.params.token, username: req.body.username, email: req.body.email || null, password: req.body.password });
            } catch (error) {
                const refreshed = await claims.lookupClaim(req.params.token);
                if (refreshed && refreshed.status !== 'active') return res.status(410).send(unavailable(statusMessage(refreshed)));
                return res.status(400).send(publicForm(req, claim, req.body, error.message));
            }
            req.session.customerUserId = redeemed.user.id;
            req.session.customerId = redeemed.customer.id;
            req.session.customerUsername = redeemed.user.username;
            return res.redirect('/account?message=' + encodeURIComponent('Account claimed. Your existing Jellyfin login and password are unchanged.'));
        } catch (error) { return next(error); }
    });

    router.use('/admin/customer-claims', gate, noStore);
    router.get('/admin/customer-claims', async (req, res, next) => {
        try { return res.send(await adminPage(req)); } catch (error) { return next(error); }
    });
    router.post('/admin/customer-claims/:customerId/create', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            await claims.createClaim({ customerId: req.params.customerId, emailLock: req.body.emailLock || null, ttlHours: req.body.ttlHours, actorUserId: req.session.authUserId });
            return res.redirect('/admin/customer-claims?message=' + encodeURIComponent('Claim link created.'));
        } catch (error) {
            return res.redirect('/admin/customer-claims?error=' + encodeURIComponent(error.message || 'Claim link could not be created.'));
        }
    });
    router.post('/admin/customer-claims/:claimId/revoke', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            await claims.revokeClaim({ claimId: req.params.claimId, actorUserId: req.session.authUserId });
            return res.redirect('/admin/customer-claims?message=' + encodeURIComponent('Claim link revoked.'));
        } catch (error) {
            return res.redirect('/admin/customer-claims?error=' + encodeURIComponent(error.message || 'Claim link could not be revoked.'));
        }
    });

    router.use('/claim', (error, _req, res, _next) => {
        console.error('Customer claim error:', error.message);
        return res.status(500).send(unavailable('The claim could not be processed right now. Please try again later.'));
    });
    return router;
}

module.exports = { createCustomerClaimRouter, adminPage, publicForm, unavailable, statusMessage };
