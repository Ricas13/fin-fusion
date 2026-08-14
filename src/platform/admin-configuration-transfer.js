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

function csrfInput(req) {
    return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`;
}

function notice(message, kind = '') {
    return message ? `<div class="notice ${kind}">${esc(message)}</div>` : '';
}

function summaryCard(label, value, detail = '') {
    return `<div class="statCard"><div class="statLabel">${esc(label)}</div><div class="statValue">${esc(value)}</div>${detail ? `<div class="statMeta">${esc(detail)}</div>` : ''}</div>`;
}

function previewMarkup(req, preview) {
    if (!preview) return '';
    const s = preview.summary;
    return `<section class="card" style="margin-top:16px">
        <div class="card-header"><div><h2 class="card-title">Import preview</h2><div class="muted">No changes have been applied yet · digest ${esc(preview.digest.slice(0, 16))}…</div></div></div>
        <div class="card-body">
            <div class="statsGrid">
                ${summaryCard('Plans to create', s.plansCreate)}
                ${summaryCard('Plans to update', s.plansUpdate)}
                ${summaryCard('Settings changes', s.settingsChange)}
                ${summaryCard('Notification changes', s.notificationsChange)}
                ${summaryCard('Server pools to apply', s.serverPoolsApply)}
                ${summaryCard('Server pools skipped', s.serverPoolsSkipped, s.serverPoolsSkipped ? 'Missing server slug references are never guessed.' : '')}
            </div>
            ${preview.warnings.length ? `<div class="notice warn" style="margin-top:14px"><strong>Warnings</strong><ul>${preview.warnings.map(item => `<li>${esc(item)}</li>`).join('')}</ul></div>` : ''}
            <div class="notice" style="margin-top:14px">Import is merge-only: it creates or updates listed plans/settings. It never deletes customers, subscriptions, plans, servers, payment records or users. A plan server pool is replaced only when every referenced server slug exists locally.</div>
            <form method="post" action="/admin/settings/configuration/apply" style="margin-top:14px">
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
            <div class="card-header"><div><h2 class="card-title">Portable configuration</h2><div class="muted">Move business configuration between installations without exporting identities, credentials or transactional data.</div></div><a class="button" href="/admin/settings/configuration/export">Export JSON</a></div>
            <div class="card-body">
                <div class="compact-item"><div><div class="compact-title">Included</div><div class="compact-meta">Plans and policy fields, plan server-pool references by slug, storefront/general settings, reseller/admin defaults, referrals and notification preferences.</div></div><span class="pill good">Portable</span></div>
                <div class="compact-item"><div><div class="compact-title">Always excluded</div><div class="compact-meta">Passwords, API keys, server URLs, customers, resellers, subscriptions, payment events/mappings, sessions, audit history and customer-specific overrides.</div></div><span class="pill">No secrets</span></div>
                <div class="compact-item"><div><div class="compact-title">Import behaviour</div><div class="compact-meta">Preview first, merge second. Existing business records not present in the import are left untouched.</div></div><span class="pill good">Non-destructive</span></div>
            </div>
        </section>
        <section class="card" style="margin-top:16px">
            <div class="card-header"><div><h2 class="card-title">Import configuration</h2><div class="muted">Paste an exported JSON document. CAPTaINFiN validates and previews it before any write occurs.</div></div></div>
            <div class="card-body">
                <form method="post" action="/admin/settings/configuration/preview">
                    ${csrfInput(req)}
                    <div class="formGroup"><label>Configuration JSON</label><textarea class="input" name="document" rows="18" maxlength="524288" spellcheck="false" required>${esc(rawDocument)}</textarea></div>
                    <button class="button secondary">Validate &amp; preview</button>
                </form>
            </div>
        </section>
        ${previewMarkup(req, preview)}`;
    return layout({
        siteName: runtimeSettings.siteName ? runtimeSettings.siteName() : (process.env.SITE_NAME || 'CAPTaINFiN'),
        active: 'configuration',
        title: 'Configuration Transfer',
        subtitle: 'Safe export/import for clean installs, staging and white-label deployments',
        body
    });
}

function sessionPreview(req) {
    const stored = req.session?.configurationImportPreview;
    if (!stored || !stored.createdAt || Date.now() - Number(stored.createdAt) > PREVIEW_TTL_MS) return null;
    if (String(stored.actorUserId) !== String(req.session.authUserId)) return null;
    return stored;
}

function createAdminConfigurationTransferRouter() {
    const router = express.Router();
    router.use('/admin/settings/configuration', gate, noStore);

    router.get('/admin/settings/configuration', (req, res) => res.send(page(req)));

    router.get('/admin/settings/configuration/export', async (req, res, next) => {
        try {
            const document = await transfer.exportPortableConfiguration();
            const digest = transfer.digestDocument(transfer.parseDocument(document));
            await query(`
                INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
                VALUES($1,'admin.configuration.export','configuration',$2,$3::jsonb)
            `, [req.session.authUserId, digest, JSON.stringify({ version: transfer.VERSION, plans: document.configuration.plans.length })]);
            const filename = `steam-fusion-configuration-${new Date().toISOString().slice(0, 10)}.json`;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            return res.send(JSON.stringify(document, null, 2));
        } catch (error) { return next(error); }
    });

    router.post('/admin/settings/configuration/preview', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        const rawDocument = String(req.body.document || '');
        try {
            const preview = await transfer.previewImport(rawDocument);
            req.session.configurationImportPreview = {
                actorUserId: req.session.authUserId,
                digest: preview.digest,
                document: preview.document,
                createdAt: Date.now()
            };
            return res.send(page(req, { rawDocument, preview }));
        } catch (error) {
            const prefix = error.path ? `${error.path}: ` : '';
            return res.status(400).send(page(req, { rawDocument, error: `${prefix}${error.message}` }));
        }
    });

    router.post('/admin/settings/configuration/apply', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        const stored = sessionPreview(req);
        if (!stored) return res.status(409).send(page(req, { error: 'The import preview expired. Validate the document again before applying it.' }));
        if (String(req.body.digest || '') !== stored.digest) return res.status(409).send(page(req, { error: 'The import preview no longer matches this request. Validate it again.' }));
        if (String(req.body.confirmation || '').trim().toUpperCase() !== 'IMPORT') return res.status(400).send(page(req, { error: 'Type IMPORT exactly to apply the preview.' }));
        try {
            const applied = await transfer.applyImport(stored.document, req.session.authUserId);
            delete req.session.configurationImportPreview;
            await runtimeSettings.reload();
            const s = applied.summary;
            const message = `Configuration imported: ${s.plansCreate} plan(s) created, ${s.plansUpdate} updated, ${s.settingsChange} setting group(s) changed, ${s.poolsSkipped} server pool(s) skipped.`;
            return res.redirect('/admin/settings/configuration?message=' + encodeURIComponent(message));
        } catch (error) {
            const prefix = error.path ? `${error.path}: ` : '';
            return res.status(400).send(page(req, { error: `${prefix}${error.message}` }));
        }
    });

    return router;
}

module.exports = { createAdminConfigurationTransferRouter, page, PREVIEW_TTL_MS };
