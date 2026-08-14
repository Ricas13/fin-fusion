'use strict';

const express = require('express');
const { layout, esc } = require('./admin-html');
const { setupReadiness } = require('./setup-readiness');

function site() { return process.env.SITE_NAME || 'CAPTaINFiN'; }
function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}
function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}
function stateLabel(state) {
    return String(state || '').replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function stateKind(state) {
    if (['configured', 'enabled', 'available'].includes(state)) return 'good';
    if (state === 'disabled') return '';
    return 'warn';
}
function checklistItem(item) {
    return `<a class="compact-item" href="${esc(item.href)}" style="text-decoration:none;color:inherit">
        <div>
            <div class="compact-title">${item.configured ? '✓' : '○'} ${esc(item.label)}</div>
            <div class="compact-meta">${esc(item.detail)}</div>
        </div>
        <span class="pill ${item.configured ? 'good' : ''}">${item.configured ? 'Configured' : 'Optional'}</span>
    </a>`;
}
function moduleRow(module) {
    return `<tr>
        <td><strong>${esc(module.name)}</strong></td>
        <td><span class="pill ${stateKind(module.state)}">${esc(stateLabel(module.state))}</span></td>
        <td class="muted">${esc(module.detail || '')}</td>
    </tr>`;
}
function page(data) {
    const body = `
        <section class="card">
            <div class="card-header">
                <div>
                    <h2 class="card-title">Setup checklist</h2>
                    <div class="muted">${esc(data.configuredCount)} / ${esc(data.totalCount)} configured · every integration is optional</div>
                </div>
            </div>
            <div class="card-body">${data.checklist.map(checklistItem).join('')}</div>
        </section>
        <section class="card" style="margin-top:16px">
            <div class="card-header">
                <div>
                    <h2 class="card-title">Feature readiness</h2>
                    <div class="muted">Pages remain safe to open even when their integration is not configured.</div>
                </div>
            </div>
            <div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Module</th><th>State</th><th>Detail</th></tr></thead><tbody>${data.modules.map(moduleRow).join('')}</tbody></table></div>
        </section>
        <section class="card" style="margin-top:16px">
            <div class="card-header"><h2 class="card-title">Clean-install rules</h2></div>
            <div class="card-body">
                <div class="compact-item"><div><div class="compact-title">Zero business objects are valid</div><div class="compact-meta">No server, plan, customer, reseller or payment provider is required for the admin UI to run.</div></div><span class="pill good">Safe</span></div>
                <div class="compact-item"><div><div class="compact-title">Customer-facing features are opt-in on new installs</div><div class="compact-meta">Storefront, public registration and referrals start disabled on a genuinely blank database.</div></div><span class="pill good">Safe default</span></div>
                <div class="compact-item"><div><div class="compact-title">Existing installations are preserved</div><div class="compact-meta">Fresh-install cleanup is gated by a migration-runner marker and is never applied during an upgrade.</div></div><span class="pill good">Upgrade safe</span></div>
            </div>
        </section>`;
    return layout({ siteName: site(), active: 'setup', title: 'Setup', subtitle: 'Configure only the parts of the platform you want to use', body });
}

function createAdminSetupRouter() {
    const router = express.Router();
    router.use('/admin/setup', gate, noStore);
    router.get('/admin/setup', async (_req, res, next) => {
        try { return res.send(page(await setupReadiness())); }
        catch (error) { return next(error); }
    });
    return router;
}

module.exports = { createAdminSetupRouter, page };
