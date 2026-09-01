'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const runtimeSettings = require('./runtime-settings');
const migrations = require('../jellyfin/server-migration');
const ui = require('./admin-ui');
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
    const labels = { succeeded: 'Moved', failed: 'Move failed', rollback_failed: 'Rollback failed', running: 'Moving', rolled_back: 'Rolled back', pending: 'Pending' };
    return `<span class="pill ${kind}">${esc(labels[status] || String(status || 'pending').replaceAll('_', ' '))}</span>`;
}
function recent(row, days = 7) {
    const at = new Date(row.requested_at || row.completed_at || row.rolled_back_at || 0).getTime();
    return Number.isFinite(at) && at >= Date.now() - days * 86400000;
}

async function data() {
    const [candidates, servers, history] = await Promise.all([
        migrations.migrationCandidates(),
        migrations.enabledServers(),
        migrations.listMigrations(150)
    ]);
    return { candidates, servers, history };
}

function moveHero(d) {
    const recentHistory = d.history.filter(row => recent(row, 7));
    const failures = recentHistory.filter(row => ['failed', 'rollback_failed'].includes(row.status));
    const rollbackFailures = failures.filter(row => row.status === 'rollback_failed');
    const moved = recentHistory.filter(row => row.status === 'succeeded').length;
    let tone = 'good', title = 'Customer moves are ready when you need them', statusLabel = 'Ready', next = 'Choose a customer and target server below. CAPTAiNFiN will run a read-only preflight before any account is changed.';
    if (rollbackFailures.length) {
        tone = 'bad';
        title = `${rollbackFailures.length} rollback ${rollbackFailures.length === 1 ? 'failure needs' : 'failures need'} attention`;
        statusLabel = 'Action needed';
        next = 'Review the failed rollback before starting another move for the affected customer.';
    } else if (failures.length) {
        tone = 'warn';
        title = `${failures.length} customer ${failures.length === 1 ? 'move failed' : 'moves failed'} in the last 7 days`;
        statusLabel = 'Review needed';
        next = 'Review the failed move and its server state before retrying that customer.';
    } else if (!d.candidates.length || d.servers.length < 2) {
        tone = 'info';
        title = 'No customer can be moved right now';
        statusLabel = 'Nothing eligible';
        next = 'A move becomes available when an active Jellyfin customer and at least two enabled servers are eligible.';
    }
    return ui.operatorHero({ tone, eyebrow: 'Customer move control room', title, body: 'Moves are staged, revalidated at cutover and keep the source account as a rollback point instead of deleting it.', statusLabel, next, facts: [
        { label: 'Moveable customers', value: String(d.candidates.length), detail: 'active Jellyfin access eligible for preflight' },
        { label: 'Enabled servers', value: String(d.servers.length), detail: 'possible source/target fleet' },
        { label: 'Moved · 7d', value: String(moved), detail: 'completed customer moves' },
        { label: 'Problems · 7d', value: String(failures.length), detail: `${rollbackFailures.length} rollback failures` }
    ], actionsHtml: failures.length ? '<a class="button" href="#migration-problems">Review recent problems</a><a class="button secondary" href="#move-customer">Preview a move</a>' : '<a class="button" href="#move-customer">Preview a move</a><a class="button secondary" href="#migration-history">Move history</a>' });
}

function form(req, d) {
    const customerOptions = d.candidates.map(c => `<option value="${esc(c.customer_id)}">${esc(c.customer_name)} · ${esc(c.plan_name)} · ${esc(c.jellyfin_username)} @ ${esc(c.source_server_name)}</option>`).join('');
    const serverOptions = d.servers.map(s => `<option value="${esc(s.id)}">${esc(s.name)} · ${esc(s.server_class)} · ${esc(s.health_status)}</option>`).join('');
    if (!d.candidates.length || d.servers.length < 2) {
        return `<div class="empty">A move needs an active customer with Jellyfin access and at least two enabled servers. Nothing is ready to move right now.</div>`;
    }
    return `<form method="post" action="/admin/provisioning/migrations/preview">
        ${csrfInput(req)}
        <div class="formGrid">
            <div class="formGroup"><label>Customer</label><select class="input" name="customerId" required><option value="">Choose customer…</option>${customerOptions}</select></div>
            <div class="formGroup"><label>Move to</label><select class="input" name="targetServerId" required><option value="">Choose target server…</option>${serverOptions}</select></div>
        </div>
        <div class="notice warn" style="margin:14px 0"><strong>Admin capacity override:</strong> leave this off for normal moves. Enable it only when you deliberately want to place this customer on a target that is already at or above its configured user limit. All other eligibility, health, library and username checks still apply.<label style="display:flex;gap:8px;align-items:flex-start;margin-top:10px"><input type="checkbox" name="allowOverCapacity" value="1" style="margin-top:3px"><span><strong>Allow this move to exceed target server capacity</strong></span></label></div>
        <button class="button">Check move safely</button>
    </form>`;
}

function previewCard(req, preview) {
    if (!preview) return '';
    const c = preview.check;
    const cap = c.capacity.maxUsers ? `${c.capacity.assignedUsers} / ${c.capacity.maxUsers} users` : `${c.capacity.assignedUsers} users · unlimited capacity`;
    const overrideNotice = c.overCapacityOverride ? '<div class="notice warn" style="margin-top:14px"><strong>Capacity override is active.</strong> The target is already at or above its configured user limit. This admin-only move will deliberately exceed that limit. Public registration and automatic placement remain blocked by the normal capacity rules.</div>' : '';
    const capacityPill = c.overCapacityOverride ? '<span class="pill warn">Admin override</span>' : '<span class="pill good">Available</span>';
    return `<section class="card" style="margin-top:16px">
        <div class="card-header"><div><h2 class="card-title">${c.overCapacityOverride ? 'Move check passed with capacity override' : 'Move check passed'}</h2><div class="muted">This preview expires in 10 minutes and every safety condition is checked again at cutover.</div></div><span class="pill ${c.overCapacityOverride ? 'warn' : 'good'}">${c.overCapacityOverride ? 'Override armed' : 'Ready'}</span></div>
        <div class="card-body">
            <div class="compact-item"><div><div class="compact-title">${esc(c.source.jellyfin_username)}</div><div class="compact-meta">${esc(c.source.server_name)} → ${esc(c.target.name)}</div></div><span class="pill">Same username</span></div>
            <div class="compact-item"><div><div class="compact-title">${esc(c.entitlement.name || c.entitlement.code)}</div><div class="compact-meta">${esc(c.entitlement.server_class)} · ${esc(c.effective.technical.streams)} stream(s)</div></div><span class="pill good">Plan eligible</span></div>
            <div class="compact-item"><div><div class="compact-title">Target capacity</div><div class="compact-meta">${esc(cap)}</div></div>${capacityPill}</div>
            <div class="compact-item"><div><div class="compact-title">Libraries</div><div class="compact-meta">${esc(c.effective.visibleNames.length)} customer libraries found on the target</div></div><span class="pill good">Matched</span></div>
            ${overrideNotice}
            <div class="notice warn" style="margin-top:14px"><strong>Customer action after the move:</strong> Jellyfin passwords cannot be read from the source server. The target account receives a random bootstrap password, so the customer must set a new Jellyfin password from their CAPTAiNFiN account.</div>
            <div class="notice" style="margin-top:10px"><strong>What does not move:</strong> Jellyfin-native watch history, playlists, favourites and other server-local user metadata stay on the original server. CAPTAiNFiN transfers access policy, username and library entitlement.</div>
            <form method="post" action="/admin/provisioning/migrations/apply" style="margin-top:14px">
                ${csrfInput(req)}
                <input type="hidden" name="previewKey" value="${esc(preview.key)}">
                <div class="formGroup"><label>Type <strong>MOVE</strong> to perform the cutover</label><input class="input" name="confirmation" autocomplete="off" required></div>
                <button class="button">Move customer</button>
            </form>
        </div>
    </section>`;
}

function rollbackControl(req, row) {
    if (row.status !== 'succeeded') return '';
    return `<details class="migrationRollback"><summary class="button secondary btn-sm">Rollback…</summary><div class="migrationRollbackBody"><strong>Return this customer to the original Jellyfin server?</strong><div class="subText">This changes their primary Jellyfin access and can interrupt active use. Type <strong>ROLLBACK</strong> to confirm.</div><form method="post" action="/admin/provisioning/migrations/${esc(row.id)}/rollback">${csrfInput(req)}<input class="input" name="confirmation" autocomplete="off" placeholder="ROLLBACK" required><button class="button btn-sm" type="submit">Rollback to original server</button></form></div></details>`;
}

function history(req, rows) {
    if (!rows.length) return '<div class="empty">No controlled customer moves have been run yet.</div>';
    return `<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Customer</th><th>Move</th><th>Result</th><th>Requested</th><th>Completed</th><th>Password</th><th>Problem</th><th></th></tr></thead><tbody>${rows.map(row => {
        const passwordState = row.status === 'succeeded' && row.target_password_reset_required ? '<span class="pill warn">Reset required</span>' : row.status === 'succeeded' ? '<span class="pill good">Set</span>' : '—';
        return `<tr>
            <td><strong>${esc(row.customer_name)}</strong><div class="planMeta">${esc(row.source_username)}</div></td>
            <td>${esc(row.source_server_name)} <span class="muted">→</span> ${esc(row.target_server_name)}</td>
            <td>${statusPill(row.status)}${row.failure_stage ? `<div class="planMeta">${esc(row.failure_stage)}</div>` : ''}</td>
            <td>${esc(dt(row.requested_at))}</td><td>${esc(dt(row.completed_at || row.rolled_back_at))}</td>
            <td>${passwordState}</td>
            <td class="problemCell" title="${esc(row.last_error || '')}">${esc(row.last_error || '—')}</td>
            <td>${rollbackControl(req, row)}</td>
        </tr>`;
    }).join('')}</tbody></table></div>`;
}

function problemCards(d) {
    const problems = d.history.filter(row => recent(row, 7) && ['failed', 'rollback_failed'].includes(row.status));
    if (!problems.length) return '';
    return `<section class="section" id="migration-problems">${ui.sectionHeader({eyebrow:'Recent exceptions',title:'Review these move problems first',description:'Recent failed moves and failed rollbacks are separated from routine history.'})}<div style="display:grid;gap:12px">${problems.slice(0,8).map(row => ui.resolutionCard({tone:row.status==='rollback_failed'?'bad':'warn',badge:row.status==='rollback_failed'?'Rollback failed':'Move failed',title:`${row.customer_name}: ${row.source_server_name} → ${row.target_server_name}`,body:row.last_error||'The customer move did not complete successfully.',reason:row.status==='rollback_failed'?'The automatic return to the source server did not complete. Verify this customer’s Jellyfin access before another migration.':'The cutover stopped before a successful move was recorded; review the failure stage and server health before retrying.',actionHtml:`<a class="button" href="/admin/users/${esc(row.customer_id)}">Open customer</a>`,secondaryHtml:'<a class="button secondary" href="/admin/servers/dashboard">Fleet health</a>'})).join('')}</div></section>`;
}

function page(req, d, preview = null, error = null) {
    const historyDisclosure = ui.detailDisclosure({title:'Customer move history',summary:`${d.history.length} recorded moves · rollback is available only with typed confirmation`,bodyHtml:`<div id="migration-history"></div>${history(req,d.history)}`});
    const body = `${notice(req.query.message, 'success')}${notice(error || req.query.error, 'error')}
        <style>.problemCell{max-width:360px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.migrationRollback>summary{list-style:none;cursor:pointer}.migrationRollback>summary::-webkit-details-marker{display:none}.migrationRollbackBody{display:grid;gap:8px;min-width:300px;margin-top:8px;padding:10px;border:1px solid #4a3840;border-radius:8px}.migrationRollbackBody form{display:grid;gap:8px;margin:0}.operatorResolutionActions{min-width:max-content}</style>
        ${moveHero(d)}
        ${problemCards(d)}
        <section class="card" id="move-customer">
            <div class="card-header"><div><h2 class="card-title">Move a customer</h2><div class="muted">First choose the customer and target. Nothing changes until the safety check passes and you type MOVE.</div></div></div>
            <div class="card-body">
                <div class="notice"><strong>The original account is kept.</strong> CAPTAiNFiN creates and validates the target first, disables the source only at cutover, then switches the primary account. If cutover fails, it attempts to restore the source and disable the target.</div>
                <div style="margin-top:14px">${form(req, d)}</div>
            </div>
        </section>
        ${previewCard(req, preview)}
        ${historyDisclosure}`;
    return layout({
        siteName: runtimeSettings.siteName(),
        active: 'server-migrations',
        title: 'Customer moves',
        subtitle: 'Move Jellyfin access between eligible servers with preflight, explicit cutover confirmation and guarded rollback',
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
            const allowOverCapacity = String(req.body.allowOverCapacity || '') === '1';
            const check = await migrations.preflight(req.body.customerId, req.body.targetServerId, { allowOverCapacity });
            const key = require('crypto').randomBytes(18).toString('base64url');
            req.session.serverMigrationPreview = {
                actorUserId: req.session.authUserId,
                customerId: check.customerId,
                targetServerId: check.target.id,
                sourceAccountId: check.source.id,
                planId: check.entitlement.plan_id,
                allowOverCapacity: check.allowOverCapacity,
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
            return res.redirect('/admin/provisioning/migrations?error=' + encodeURIComponent('Move preview expired or no longer matches. Run the safety check again.'));
        }
        if (String(req.body.confirmation || '').trim().toUpperCase() !== 'MOVE') {
            return res.redirect('/admin/provisioning/migrations?error=' + encodeURIComponent('Type MOVE exactly to perform the customer move.'));
        }
        try {
            const allowOverCapacity = Boolean(preview.allowOverCapacity);
            const check = await migrations.preflight(preview.customerId, preview.targetServerId, {
                expectedSourceAccountId: preview.sourceAccountId,
                allowOverCapacity
            });
            if (String(check.entitlement.plan_id) !== String(preview.planId)) throw new Error('The customer plan changed after preview. Run the safety check again.');
            const created = await migrations.createMigration(preview.customerId, preview.targetServerId, req.session.authUserId, { allowOverCapacity });
            await migrations.executeMigration(created.id);
            delete req.session.serverMigrationPreview;
            return res.redirect('/admin/provisioning/migrations?message=' + encodeURIComponent('Customer moved successfully. Ask them to set a new Jellyfin password from their account portal.'));
        } catch (error) {
            delete req.session.serverMigrationPreview;
            return res.redirect('/admin/provisioning/migrations?error=' + encodeURIComponent(error.message || 'Customer move failed.'));
        }
    });

    router.post('/admin/provisioning/migrations/:migrationId/rollback', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        if (String(req.body.confirmation || '').trim().toUpperCase() !== 'ROLLBACK') {
            return res.redirect('/admin/provisioning/migrations?error=' + encodeURIComponent('Type ROLLBACK exactly to return the customer to the original server.'));
        }
        try {
            await migrations.rollbackMigration(req.params.migrationId, req.session.authUserId);
            return res.redirect('/admin/provisioning/migrations?message=' + encodeURIComponent('Customer returned to the original Jellyfin server.'));
        } catch (error) {
            return res.redirect('/admin/provisioning/migrations?error=' + encodeURIComponent(error.message || 'Rollback failed.'));
        }
    });

    return router;
}

module.exports = { createAdminServerMigrationsRouter, page, data, PREVIEW_TTL_MS, moveHero, rollbackControl };