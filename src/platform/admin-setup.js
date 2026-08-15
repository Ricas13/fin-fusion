'use strict';

const express = require('express');
const { layout, esc } = require('./admin-html');
const { setupReadiness } = require('./setup-readiness');
const runtimeSettings = require('./runtime-settings');

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}
function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}
function stateLabel(state) { return String(state || '').replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase()); }
function stateKind(state) {
    if (['configured', 'enabled', 'available'].includes(state)) return 'good';
    if (state === 'disabled') return '';
    return 'warn';
}
function checklistItem(item) {
    return `<a class="compact-item" href="${esc(item.href)}" style="text-decoration:none;color:inherit"><div><div class="compact-title">${item.configured ? '✓' : '○'} ${esc(item.label)}</div><div class="compact-meta">${esc(item.detail)}</div></div><span class="pill ${item.configured ? 'good' : ''}">${item.configured ? 'Configured' : 'Optional'}</span></a>`;
}
function moduleRow(module) {
    return `<tr><td><strong>${esc(module.name)}</strong></td><td><span class="pill ${stateKind(module.state)}">${esc(stateLabel(module.state))}</span></td><td class="muted">${esc(module.detail || '')}</td></tr>`;
}
function page(data) {
    const body = `<section class="card"><div class="card-header"><div><h2 class="card-title">Setup checklist</h2><div class="muted">${esc(data.configuredCount)} / ${esc(data.totalCount)} configured · every integration is optional</div></div></div><div class="card-body">${data.checklist.map(checklistItem).join('')}</div></section>
        <section class="card" style="margin-top:16px"><div class="card-header"><div><h2 class="card-title">Feature readiness</h2><div class="muted">Pages remain safe to open even when their integration is not configured.</div></div></div><div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Module</th><th>State</th><th>Detail</th></tr></thead><tbody>${data.modules.map(moduleRow).join('')}</tbody></table></div></section>
        <section class="card" style="margin-top:16px"><div class="card-header"><div><h2 class="card-title">Installation portability</h2><div class="muted">Move business configuration without moving users or secrets.</div></div><a class="button secondary" href="/admin/configuration">Open configuration transfer</a></div><div class="card-body"><div class="compact-item"><div><div class="compact-title">Export portable business configuration</div><div class="compact-meta">Plans and request quotas, storefront settings, reseller tiers/catalogue rules, non-secret payment mapping references, notification preferences, automation schedules and policy-audit settings are exported in a versioned JSON document.</div></div><span class="pill good">Safe export</span></div><div class="compact-item"><div><div class="compact-title">Preview before import</div><div class="compact-meta">Imports are validated and shown as create/update counts before an administrator confirms them. Secrets, identities and provider credentials are never expected in the file.</div></div><span class="pill good">Merge only</span></div></div></section>
        <section class="card" style="margin-top:16px"><div class="card-header"><h2 class="card-title">Clean-install rules</h2></div><div class="card-body"><div class="compact-item"><div><div class="compact-title">Zero business objects are valid</div><div class="compact-meta">No server, plan, customer, reseller or payment provider is required for the admin UI to run.</div></div><span class="pill good">Safe</span></div><div class="compact-item"><div><div class="compact-title">Customer-facing features are opt-in on new installs</div><div class="compact-meta">Storefront, public registration and referrals start disabled on a genuinely blank database.</div></div><span class="pill good">Safe default</span></div><div class="compact-item"><div><div class="compact-title">Existing installations are preserved</div><div class="compact-meta">Fresh-install cleanup is gated by a migration-runner marker and is never applied during an upgrade.</div></div><span class="pill good">Upgrade safe</span></div></div></section>`;
    return layout({ siteName: runtimeSettings.siteName(), active: 'setup', title: 'Setup', subtitle: 'Configure only the parts of the platform you want to use', body });
}

function createAdminSetupRouter() {
    const router = express.Router();
    router.use('/admin/setup', gate, noStore);
    router.get('/admin/setup', async (_req, res, next) => {
        try { await runtimeSettings.ensureLoaded(); return res.send(page(await setupReadiness())); }
        catch (error) { return next(error); }
    });
    return router;
}

module.exports = { createAdminSetupRouter, page };
