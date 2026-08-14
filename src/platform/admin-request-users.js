'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const runtimeSettings = require('./runtime-settings');
const requestUsers = require('../integrations/request-user-sync');
const { layout, esc } = require('./admin-html');

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
function dt(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
function pill(status) {
    const value = status || 'pending';
    const kind = value === 'synced' ? 'good' : value === 'failed' ? 'bad' : value === 'skipped' ? 'warn' : '';
    return `<span class="pill ${kind}">${esc(value[0].toUpperCase() + value.slice(1))}</span>`;
}
function notice(req) {
    return `${req.query.message ? `<div class="notice success">${esc(req.query.message)}</div>` : ''}${req.query.error ? `<div class="notice error">${esc(req.query.error)}</div>` : ''}`;
}

async function page(req) {
    const [summary, candidates] = await Promise.all([requestUsers.statusSummary(), requestUsers.syncCandidates()]);
    const counts = summary.counts || {};
    const configured = summary.configured;
    const configCard = `<section class="card">
        <div class="card-header"><div><h2 class="card-title">Central request service</h2><div class="muted">One Overseerr/Seerr instance for users spread across any number of Jellyfin servers.</div></div><a class="button secondary" href="/admin/settings">Settings</a></div>
        <div class="card-body">
            <div class="compact-item"><div><div class="compact-title">Request URL</div><div class="compact-meta">${esc(summary.baseUrl || 'Not configured')}</div></div><span class="pill ${summary.baseUrl ? 'good' : 'warn'}">${summary.baseUrl ? 'Configured' : 'Missing'}</span></div>
            <div class="compact-item"><div><div class="compact-title">API key</div><div class="compact-meta">Set SEERR_API_KEY or OVERSEERR_API_KEY on the CAPTaINFiN app. The key is never shown in the browser.</div></div><span class="pill ${summary.apiKey ? 'good' : 'warn'}">${summary.apiKey ? 'Configured' : 'Missing'}</span></div>
            <div class="compact-item"><div><div class="compact-title">Sync model</div><div class="compact-meta">Customers are deduplicated by CAPTaINFiN customer identity and linked to the central request account by email. Expired/removed users are never automatically deleted from the request service, preserving request history.</div></div><span class="pill good">Non-destructive</span></div>
        </div>
    </section>`;

    const metrics = `<div class="metrics" style="margin-top:16px">
        <div class="metric"><div class="metricLabel">Active Jellyfin users</div><div class="metricValue smallish">${candidates.length}</div></div>
        <div class="metric"><div class="metricLabel">Synced</div><div class="metricValue smallish">${counts.synced || 0}</div></div>
        <div class="metric"><div class="metricLabel">Needs email</div><div class="metricValue smallish">${counts.skipped || 0}</div></div>
        <div class="metric"><div class="metricLabel">Failed</div><div class="metricValue smallish">${counts.failed || 0}</div></div>
    </div>`;

    const rows = candidates.map(row => {
        const email = row.email || 'No email';
        const state = row.status || 'pending';
        const password = row.password_reset_required
            ? '<span class="pill warn">Request password needed</span>'
            : row.external_user_id ? '<span class="pill good">Ready</span>' : '—';
        return `<tr>
            <td><strong>${esc(row.username || 'User')}</strong><div class="planMeta">${esc(email)}</div></td>
            <td>${esc(row.active_servers || '—')}<div class="planMeta">${esc(row.active_server_count || 0)} active server${Number(row.active_server_count) === 1 ? '' : 's'}</div></td>
            <td>${pill(state)}</td>
            <td>${row.external_user_id ? `#${esc(row.external_user_id)}<div class="planMeta">${esc(row.external_username || '')}</div>` : '—'}</td>
            <td>${password}</td>
            <td>${esc(dt(row.last_success_at || row.last_attempt_at))}</td>
            <td class="problemCell" title="${esc(row.last_error || '')}">${esc(row.last_error || '—')}</td>
            <td class="right"><form method="post" action="/admin/request-users/${esc(row.customer_id)}/sync">${csrfInput(req)}<button class="button secondary" type="submit">Sync</button></form></td>
        </tr>`;
    }).join('');

    const table = `<section class="section"><div class="sectionHead"><div><h2>Managed request users</h2><div class="muted">One row per CAPTaINFiN customer, regardless of how many Jellyfin servers they use.</div></div><span class="muted">${candidates.length} active</span></div>${candidates.length ? `<div class="tableWrap"><table class="dataTable requestUserTable"><thead><tr><th>Customer</th><th>Jellyfin servers</th><th>Sync</th><th>Request user</th><th>Login</th><th>Last sync</th><th>Problem</th><th class="right">Action</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">No active Jellyfin users to sync yet.</div>'}</section>`;

    const action = `<form method="post" action="/admin/request-users/sync-all">${csrfInput(req)}<button class="button" type="submit" ${configured ? '' : 'disabled'}>Sync all users</button></form>`;
    const styles = '<style>.requestUserTable{min-width:1180px}.problemCell{max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.metricValue.smallish{font-size:22px}</style>';
    return layout({
        siteName: runtimeSettings.siteName(),
        active: 'request-users',
        title: 'Request User Sync',
        subtitle: 'Aggregate users from every Jellyfin server into one Overseerr/Seerr instance',
        action,
        body: `${styles}${notice(req)}${configCard}${metrics}${table}`
    });
}

function createAdminRequestUsersRouter() {
    const router = express.Router();
    router.use('/admin/request-users', gate, noStore);
    router.get('/admin/request-users', async (req, res, next) => {
        try { return res.send(await page(req)); } catch (error) { return next(error); }
    });
    router.post('/admin/request-users/sync-all', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const result = await requestUsers.syncAll();
            const message = `Request users synced: ${result.created} created, ${result.linked} linked, ${result.skipped} skipped, ${result.failed} failed.`;
            return res.redirect('/admin/request-users?message=' + encodeURIComponent(message));
        } catch (error) {
            return res.redirect('/admin/request-users?error=' + encodeURIComponent(error.message || 'Request user sync failed.'));
        }
    });
    router.post('/admin/request-users/:customerId/sync', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const result = await requestUsers.syncOneCustomer(req.params.customerId);
            const message = result.status === 'synced' ? 'Request user synced.' : `Request user ${result.status}.`;
            return res.redirect('/admin/request-users?message=' + encodeURIComponent(message));
        } catch (error) {
            return res.redirect('/admin/request-users?error=' + encodeURIComponent(error.message || 'Request user sync failed.'));
        }
    });
    return router;
}

module.exports = { createAdminRequestUsersRouter, page };
