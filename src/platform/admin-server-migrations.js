'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const runtimeSettings = require('./runtime-settings');
const migrations = require('../jellyfin/server-migration');
const { layout, esc } = require('./admin-html');

const PREVIEW_TTL_MS = 10 * 60 * 1000;

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
function notice(value, kind = '') { return value ? `<div class="notice ${kind}">${esc(value)}</div>` : ''; }
function dt(value) {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
function statusPill(status) {
    const kind = status === 'succeeded' ? 'good' : status === 'failed' || status === 'rollback_failed' ? 'bad' : status === 'running' ? 'accent' : status === 'rolled_back' ? 'warn' : '';
    return `<span class="pill ${kind}">${esc(String(status || 'pending').replace('_', ' '))}</span>`;
}

async function data() {
    const [candidates, servers, history] = await Promise.all([
        migrations.migrationCandidates(),
        migrations.enabledServers(),
        migrations.listMigrations(150)
    ]);
    return { candidates, servers, history };
}

function form(req, d) {
    const customerOptions = d.candidates.map(c => `<option value="${esc(c.customer_id)}">${esc(c.customer_name)} · ${esc(c.plan_name)} · ${esc(c.jellyfin_username)} @ ${esc(c.source_server_name)}</option>`).join('');
    const serverOptions = d.servers.map(s => `<option value="${esc(s.id)}">${esc(s.name)} · ${esc(s.server_class)} · ${esc(s.health_status)}</option>`).join('');
    if (!d.candidates.length || d.servers.length < 2) {
        return `<div class="empty">A migration needs an active customer with Jellyfin access and at least two enabled servers. Nothing is ready to move right now.</div>`;
    }
    return `<form method="post" action="/admin/provisioning/migrations/preview">
        ${csrfInput(req)}
        <div class="formGrid">
            <div class="formGroup"><label>Customer</label><select class="input" name="customerId" required><option value="">Choose customer…</option>${customerOptions}</select></div>
            <div class="formGroup"><label>Target server</label><select class="input" name="targetServerId" required><option value="">Choose target…</option>${serverOptions}</select></div>
        </div>
        <button class="button">Preflight migration</button>
    </form>`;
}

function previewCard(req, preview) {
    if (!preview) return '';
    const c = preview.check;
    const cap = c.capacity.maxUsers ? `${c.capacity.assignedUsers} / ${c.capacity.maxUsers} users` : `${c.capacity.assignedUsers} users · unlimited capacity`;
    return `<section class="card" style="margin-top:16px">
        <div class="card-header"><div><h2 class="card-title">Migration preflight passed</h2><div class="muted">This preview expires in 10 minutes and is revalidated at cutover.</div></div><span class="pill good">Ready</span></div>
        <div class="card-body">
            <div class="compact-item"><div><div class="compact-title">${esc(c.source.jellyfin_username)}</div><div class="compact-meta">${esc(c.source.server_name)} → ${esc(c.target.name)}</div></div><span class="pill">Same username</span></div>
            <div class="compact-item"><div><div class="compact-title">${esc(c.entitlement.name || c.entitlement.code)}</div><div class="compact-meta">${esc(c.entitlement.code)} · ${esc(c.entitlement.server_class)} · ${esc(c.effective.technical.streams)} stream(s)</div></div><span class="pill good">Plan eligible</span></div>
            <div class="compact-item"><div><div class="compact-title">Target capacity</div><div class="compact-meta">${esc(cap)}</div></div><span class="pill good">Available</span></div>
            <div class="compact-item"><div><div class="compact-title">Libraries</div><div class="compact-meta">${esc(c.effective.visibleNames.length)} effective libraries checked against target</div></div><span class="pill good">Matched</span></div>
            <div class="notice warn" style="margin-top:14px"><strong>Password reset required:</strong> Jellyfin passwords cannot be read back from the source server. The target account receives a random bootstrap password, so the customer must set a new Jellyfin password from their CAPTAiNFiN account after the move.</div>
            <div class="notice" style="margin-top:10px"><strong>Not transferred:</strong> Jellyfin-native watch history, playlists, favourites and other server-local user metadata are not copied by this migration. CAPTAiNFiN access policy, username and library entitlement are transferred.</div>
            <form method="post" action="/admin/provisioning/migrations/apply" style="margin-top:14px">
                ${csrfInput(req)}
                <input type="hidden" name="previewKey" value="${esc(preview.key)}">
                <div class="formGroup"><label>Type <strong>MOVE</strong> to perform the cutover</label><input class="input" name="confirmation" autocomplete="off" required></div>
                <button class="button">Move customer</button>
            </form>
        </div>
    </section>`;
}

function history(req, rows) {
    if (!rows.length) return '<div class="empty">No controlled server migrations have been run yet.</div>';
    return `<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Customer</th><th>Route</th><th>Status</th><th>Requested</th><th>Completed</th><th>Password</th><th>Problem</th><th></th></tr></thead><tbody>${rows.map(row => {
        const canRollback = row.status === 'succeeded';
        const passwordState = row.status === 'succeeded' && row.target_password_reset_required ? '<span class="pill warn">Reset required</span>' : row.status === 'succeeded' ? '<span class="pill good">Set</span>' : '—';
        return `<tr>
            <td><strong>${esc(row.customer_name)}</strong><div class="planMeta">${esc(row.source_username)}</div></td>
            <td>${esc(row.source_server_name)} <span class="muted">→</span> ${esc(row.target_server_name)}</td>
            <td>${statusPill(row.status)}${row.failure_stage ? `<div class="planMeta">${esc(row.failure_stage)}</div>` : ''}</td>
            <td>${esc(dt(row.requested_at))}</td><td>${esc(dt(row.completed_at || row.rolled_back_at))}</td>
            <td>${passwordState}</td>
            <td class="problemCell" title="${esc(row.last_error || '')}">${esc(row.last_error || '—')}</td>
            <td>${canRollback ? `<form method="post" action="/admin/provisioning/migrations/${esc(row.id)}/rollback">${csrfInput(req)}<input type="hidden" name="confirmation" value="ROLLBACK"><button class="button secondary" type="submit">Rollback</button></form>` : ''}</td>
        </tr>`;
    }).join('')}</tbody></table></div>`;
}

function page(req, d, preview = null, error = null) {
    const body = `${notice(req.query.message, 'success')}${notice(error || req.query.error, 'error')}
        <style>.problemCell{max-width:360px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}</style>
        <section class="card">
            <div class="card-header"><div><h2 class="card-title">Move a customer</h2><div class="muted">Controlled account cutover with preflight, failure cleanup and rollback.</div></div></div>
            <div class="card-body">
                <div class="notice">The source account is never deleted. CAPTAiNFiN creates and validates the target first, disables the source only at cutover, then switches the primary account. A cutover failure attempts to restore the source and disable the target.</div>
                <div style="margin-top:14px">${form(req, d)}</div>
            </div>
        </section>
        ${previewCard(req, preview)}
        <section class="card" style="margin-top:16px">
            <div class="card-header"><div><h2 class="card-title">Migration history</h2><div class="muted">Source accounts stay available as disabled rollback points.</div></div></div>
            <div class="card-body" style="padding:0">${history(req, d.history)}</div>
        </section>`;
    return layout({
        siteName: runtimeSettings.siteName(),
        active: 'server-migrations',
        title: 'Server Migrations',
        subtitle: 'Controlled Jellyfin customer moves between eligible servers',
        body
    });
}

function savedPreview(req) {
    const value = req.session?.serverMigrationPreview;
    if (!value || Date.now() - Number(value.createdAt || 0) > PREVIEW_TTL_MS) return null;
    if (String(value.actorUserId) !== String(req.session.authUserId)) return null;
    return value;
}

function createAdminServerMigrationsRouter() {
    const router = express.Router();
    router.use('/admin/provisioning/migrations', gate, noStore);

    router.get('/admin/provisioning/migrations', async (req, res, next) => {
        try { return res.send(page(req, await data())); } catch (error) { return next(error); }
    });

    router.post('/admin/provisioning/migrations/preview', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        const d = await data();
        try {
            const check = await migrations.preflight(req.body.customerId, req.body.targetServerId);
            const key = require('crypto').randomBytes(18).toString('base64url');
            req.session.serverMigrationPreview = {
                actorUserId: req.session.authUserId,
                customerId: check.customerId,
                targetServerId: check.target.id,
                sourceAccountId: check.source.id,
                planId: check.entitlement.plan_id,
                key,
                createdAt: Date.now()
            };
            return res.send(page(req, d, { key, check }));
        } catch (error) {
            return res.status(400).send(page(req, d, null, error.message));
        }
    });

    router.post('/admin/provisioning/migrations/apply', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        const preview = savedPreview(req);
        if (!preview || preview.key !== String(req.body.previewKey || '')) {
            return res.redirect('/admin/provisioning/migrations?error=' + encodeURIComponent('Migration preview expired or no longer matches. Run preflight again.'));
        }
        if (String(req.body.confirmation || '').trim().toUpperCase() !== 'MOVE') {
            return res.redirect('/admin/provisioning/migrations?error=' + encodeURIComponent('Type MOVE exactly to perform the migration.'));
        }
        try {
            const check = await migrations.preflight(preview.customerId, preview.targetServerId, { expectedSourceAccountId: preview.sourceAccountId });
            if (String(check.entitlement.plan_id) !== String(preview.planId)) throw new Error('The customer plan changed after preview. Run preflight again.');
            const created = await migrations.createMigration(preview.customerId, preview.targetServerId, req.session.authUserId);
            await migrations.executeMigration(created.id);
            delete req.session.serverMigrationPreview;
            return res.redirect('/admin/provisioning/migrations?message=' + encodeURIComponent('Customer moved successfully. Ask them to set a new Jellyfin password from their account portal.'));
        } catch (error) {
            delete req.session.serverMigrationPreview;
            return res.redirect('/admin/provisioning/migrations?error=' + encodeURIComponent(error.message || 'Migration failed.'));
        }
    });

    router.post('/admin/provisioning/migrations/:migrationId/rollback', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        if (String(req.body.confirmation || '').toUpperCase() !== 'ROLLBACK') {
            return res.redirect('/admin/provisioning/migrations?error=' + encodeURIComponent('Rollback confirmation was missing.'));
        }
        try {
            await migrations.rollbackMigration(req.params.migrationId, req.session.authUserId);
            return res.redirect('/admin/provisioning/migrations?message=' + encodeURIComponent('Migration rolled back to the original Jellyfin server.'));
        } catch (error) {
            return res.redirect('/admin/provisioning/migrations?error=' + encodeURIComponent(error.message || 'Rollback failed.'));
        }
    });

    return router;
}

module.exports = { createAdminServerMigrationsRouter, page, data, PREVIEW_TTL_MS };
