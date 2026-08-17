'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const runtimeSettings = require('./runtime-settings');
const transfer = require('./configuration-transfer');
const { query } = require('../db');
const { layout, esc } = require('./admin-html');

const PREVIEW_TTL_MS = 15 * 60 * 1000;

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}
function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}
function csrfInput(req) { return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`; }
function notice(message, kind = '') { return message ? `<div class="notice ${kind}">${esc(message)}</div>` : ''; }
function summaryCard(label, value, detail = '') { return `<div class="statCard"><div class="statLabel">${esc(label)}</div><div class="statValue">${esc(value ?? 0)}</div>${detail ? `<div class="statMeta">${esc(detail)}</div>` : ''}</div>`; }
function summaryValue(summary, ...keys) { for (const key of keys) if (summary && summary[key] != null) return summary[key]; return 0; }

function previewMarkup(req, preview) {
    if (!preview) return '';
    const s = preview.summary || {};
    const create = summaryValue(s, 'plansCreate');
    const update = summaryValue(s, 'plansUpdate');
    const settings = summaryValue(s, 'settingsChange', 'extendedSettings');
    const notifications = summaryValue(s, 'notificationsChange');
    const tierCreate = summaryValue(s, 'resellerTiersCreate');
    const tierUpdate = summaryValue(s, 'resellerTiersUpdate');
    const mappings = summaryValue(s, 'directPaymentMappings');
    const jobs = summaryValue(s, 'automationJobs');
    return `<section class="card" style="margin-top:16px">
        <div class="card-header"><div><h2 class="card-title">Import preview</h2><div class="muted">No changes have been applied yet · digest ${esc(preview.digest.slice(0, 16))}…</div></div></div>
        <div class="card-body">
            <div class="statsGrid">
                ${summaryCard('Plans to create', create)}
                ${summaryCard('Plans to update', update)}
                ${summaryCard('Reseller tiers to create', tierCreate)}
                ${summaryCard('Reseller tiers to update', tierUpdate)}
                ${summaryCard('Settings / policy groups', settings)}
                ${summaryCard('Notification changes', notifications)}
                ${summaryCard('Payment mappings', mappings)}
                ${summaryCard('Automation schedules', jobs)}
            </div>
            ${preview.warnings?.length ? `<div class="notice warn" style="margin-top:14px"><strong>Warnings</strong><ul>${preview.warnings.map(item => `<li>${esc(item)}</li>`).join('')}</ul></div>` : ''}
            <div class="notice" style="margin-top:14px">Import is merge-only. It never deletes customers, resellers, subscriptions, payment transactions, users or secrets. References that cannot be resolved safely are skipped and reported.</div>
            <form method="post" action="/admin/configuration/apply" style="margin-top:14px">
                ${csrfInput(req)}
                <input type="hidden" name="digest" value="${esc(preview.digest)}">
                <div class="formGroup"><label>Type <strong>IMPORT</strong> to apply this preview</label><input class="input" name="confirmation" autocomplete="off" required></div>
                <button class="button">Apply configuration</button>
            </form>
        </div>
    </section>`;
}

function page(req, { rawDocument = '', preview = null, error = null, message = null } = {}) {
    const body = `${notice(message || req.query.message, 'success')}${notice(error || req.query.error, 'error')}
        <section class="card">
            <div class="card-header"><div><h2 class="card-title">Portable configuration V2</h2><div class="muted">Move business configuration between installations without exporting identities, credentials or transactional data.</div></div><a class="button" href="/admin/configuration/export">Export JSON</a></div>
            <div class="card-body">
                <div class="compact-item"><div><div class="compact-title">Included</div><div class="compact-meta">Plans and request quotas, reseller tiers and tier catalogue rules, storefront/settings, non-secret payment mapping references, notification preferences, automation schedules and Jellyfin drift-audit policy.</div></div><span class="pill good">Portable</span></div>
                <div class="compact-item"><div><div class="compact-title">Always excluded</div><div class="compact-meta">Passwords, API keys, provider/email/request credentials, server secrets/URLs, customers, resellers, subscriptions, transactions, sessions, audit/auth history and branding binary assets.</div></div><span class="pill">No secrets</span></div>
                <div class="compact-item"><div><div class="compact-title">Import behaviour</div><div class="compact-meta">Preview first, merge second. Existing business records not present in the import are left untouched. V1 files remain accepted.</div></div><span class="pill good">Non-destructive</span></div>
            </div>
        </section>
        <section class="card" style="margin-top:16px">
            <div class="card-header"><div><h2 class="card-title">Import configuration</h2><div class="muted">Paste an exported JSON document. CAPTAiNFiN validates and previews it before any write occurs.</div></div></div>
            <div class="card-body">
                <form method="post" action="/admin/configuration/preview">
                    ${csrfInput(req)}
                    <div class="formGroup"><label>Configuration JSON</label><textarea class="input" name="document" rows="18" maxlength="1048576" spellcheck="false" required>${esc(rawDocument)}</textarea></div>
                    <button class="button secondary">Validate &amp; preview</button>
                </form>
            </div>
        </section>
        ${previewMarkup(req, preview)}`;
    return layout({ siteName: runtimeSettings.siteName(), active: 'configuration-transfer', title: 'Configuration Transfer', subtitle: 'Versioned portable business configuration with safe merge previews', body });
}

function sessionPreview(req) {
    const stored = req.session?.configurationImportPreview;
    if (!stored || !stored.createdAt || Date.now() - Number(stored.createdAt) > PREVIEW_TTL_MS) return null;
    if (String(stored.actorUserId) !== String(req.session.authUserId)) return null;
    return stored;
}

function createAdminConfigurationTransferRouter() {
    const router = express.Router();
    // Old links remain harmless during upgrades, but all forms and navigation
    // use the canonical top-level administration path.
    router.get('/admin/settings/configuration', gate, noStore, (_req, res) => res.redirect(301, '/admin/configuration'));
    router.get('/admin/settings/configuration/export', gate, noStore, (_req, res) => res.redirect(307, '/admin/configuration/export'));

    router.use('/admin/configuration', gate, noStore);
    router.get('/admin/configuration', (req, res) => res.send(page(req)));

    router.get('/admin/configuration/export', async (req, res, next) => {
        try {
            const document = await transfer.exportPortableConfiguration();
            const digest = transfer.digestDocument(transfer.parseDocument(document));
            await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.configuration.export','configuration',$2,$3::jsonb)`, [req.session.authUserId, digest, JSON.stringify({ version: transfer.VERSION, plans: document.configuration.plans.length })]);
            const filename = `captainfin-configuration-v${document.version}-${new Date().toISOString().slice(0, 10)}.json`;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            return res.send(JSON.stringify(document, null, 2));
        } catch (error) { return next(error); }
    });

    router.post('/admin/configuration/preview', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        const rawDocument = String(req.body.document || '');
        try {
            const preview = await transfer.previewImport(rawDocument);
            req.session.configurationImportPreview = { actorUserId: req.session.authUserId, digest: preview.digest, document: preview.document, createdAt: Date.now() };
            return res.send(page(req, { rawDocument, preview }));
        } catch (error) {
            const prefix = error.path ? `${error.path}: ` : '';
            return res.status(400).send(page(req, { rawDocument, error: `${prefix}${error.message}` }));
        }
    });

    router.post('/admin/configuration/apply', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        const stored = sessionPreview(req);
        if (!stored) return res.status(409).send(page(req, { error: 'The import preview expired. Validate the document again before applying it.' }));
        if (String(req.body.digest || '') !== stored.digest) return res.status(409).send(page(req, { error: 'The import preview no longer matches this request. Validate it again.' }));
        if (String(req.body.confirmation || '').trim().toUpperCase() !== 'IMPORT') return res.status(400).send(page(req, { error: 'Type IMPORT exactly to apply the preview.' }));
        try {
            const applied = await transfer.applyImport(stored.document, req.session.authUserId);
            delete req.session.configurationImportPreview;
            await runtimeSettings.reload();
            const s = applied.summary || {};
            const message = `Configuration imported: ${summaryValue(s,'plansCreate')} plan(s) created, ${summaryValue(s,'plansUpdate')} updated, ${summaryValue(s,'resellerTiersCreate')} reseller tier(s) created, ${summaryValue(s,'resellerTiersUpdate')} updated, ${summaryValue(s,'skippedReferences')} unresolved reference(s) skipped.`;
            return res.redirect('/admin/configuration?message=' + encodeURIComponent(message));
        } catch (error) {
            const prefix = error.path ? `${error.path}: ` : '';
            return res.status(400).send(page(req, { error: `${prefix}${error.message}` }));
        }
    });

    return router;
}

module.exports = { createAdminConfigurationTransferRouter, page, PREVIEW_TTL_MS };
