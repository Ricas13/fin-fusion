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
function quota(limit, days) {
    return limit == null || Number(limit) === 0 ? 'Unlimited' : `${Number(limit)} / ${Number(days) || 30}d`;
}

async function page(req) {
    const [summary, candidates] = await Promise.all([requestUsers.statusSummary(), requestUsers.syncCandidates()]);
    const counts = summary.counts || {};
    const configured = summary.configured;
    const active = candidates.filter(row => row.entitlement_active).length;
    const passwordsNeeded = candidates.filter(row => row.password_reset_required && !row.access_suspended).length;
    const configCard = `<section class="card">
        <div class="card-header"><div><h2 class="card-title">Central request service</h2><div class="muted">One Overseerr/Seerr instance for users spread across any number of Jellyfin servers.</div></div><div class="buttonRow"><a class="button secondary" href="/admin/request-plan-policy">Plan limits</a><a class="button secondary" href="/admin/settings">Settings</a></div></div>
        <div class="card-body">
            <div class="compact-item"><div><div class="compact-title">Request URL</div><div class="compact-meta">${esc(summary.baseUrl || 'Not configured')}</div></div><span class="pill ${summary.baseUrl ? 'good' : 'warn'}">${summary.baseUrl ? 'Configured' : 'Missing'}</span></div>
            <div class="compact-item"><div><div class="compact-title">API key</div><div class="compact-meta">Set SEERR_API_KEY or OVERSEERR_API_KEY on the CAPTaINFiN app. The key is never shown in the browser.</div></div><span class="pill ${summary.apiKey ? 'good' : 'warn'}">${summary.apiKey ? 'Configured' : 'Missing'}</span></div>
            <div class="compact-item"><div><div class="compact-title">Lifecycle</div><div class="compact-meta">Active subscriptions receive their plan quota. Expired access has request permissions set to zero without deleting the request user or request history. Renewal restores the remembered permissions.</div></div><span class="pill good">Subscription controlled</span></div>
        </div>
    </section>`;

    const metrics = `<div class="metrics" style="margin-top:16px">
        <div class="metric"><div class="metricLabel">Active request access</div><div class="metricValue smallish">${active}</div></div>
        <div class="metric"><div class="metricLabel">Suspended</div><div class="metricValue smallish">${summary.suspended || 0}</div></div>
        <div class="metric"><div class="metricLabel">Need request password</div><div class="metricValue smallish">${passwordsNeeded}</div></div>
        <div class="metric"><div class="metricLabel">Failed</div><div class="metricValue smallish">${counts.failed || 0}</div></div>
    </div>`;

    const rows = candidates.map(row => {
        const loginEmail = row.external_email || row.email || 'Assigned at first sync';
        const state = row.status || 'pending';
        const access = row.access_suspended || !row.entitlement_active
            ? '<span class="pill warn">Suspended</span>'
            : '<span class="pill good">Active</span>';
        const password = row.password_reset_required && !row.access_suspended
            ? '<span class="pill warn">Password needed</span>'
            : row.external_user_id ? '<span class="pill good">Ready</span>' : '—';
        const movie = row.entitlement_active
            ? quota(row.request_movie_quota_limit, row.request_movie_quota_days)
            : quota(row.applied_movie_quota_limit, row.applied_movie_quota_days);
        const tv = row.entitlement_active
            ? quota(row.request_tv_quota_limit, row.request_tv_quota_days)
            : quota(row.applied_tv_quota_limit, row.applied_tv_quota_days);
        return `<tr>
            <td><strong>${esc(row.username || 'User')}</strong><div class="planMeta">${esc(loginEmail)}</div></td>
            <td>${access}<div class="planMeta">${row.entitlement_active ? esc(row.plan_name || row.plan_code || 'Active plan') : 'No active entitlement'}</div></td>
            <td><strong>${esc(movie)}</strong><div class="planMeta">movies</div></td>
            <td><strong>${esc(tv)}</strong><div class="planMeta">TV seasons</div></td>
            <td>${esc(row.active_servers || '—')}<div class="planMeta">${esc(row.active_server_count || 0)} active server${Number(row.active_server_count) === 1 ? '' : 's'}</div></td>
            <td>${pill(state)}</td>
            <td>${row.external_user_id ? `#${esc(row.external_user_id)}<div class="planMeta">${esc(row.external_username || '')}</div>` : '—'}</td>
            <td>${password}</td>
            <td>${esc(dt(row.last_success_at || row.last_attempt_at))}</td>
            <td class="problemCell" title="${esc(row.last_error || '')}">${esc(row.last_error || '—')}</td>
            <td class="right"><form method="post" action="/admin/request-users/${esc(row.customer_id)}/sync">${csrfInput(req)}<button class="button secondary" type="submit">Sync</button></form></td>
        </tr>`;
    }).join('');

    const table = `<section class="section"><div class="sectionHead"><div><h2>Managed request users</h2><div class="muted">One row per CAPTaINFiN customer. TV quota uses Overseerr/Seerr's native season-based counting.</div></div><span class="muted">${candidates.length} managed</span></div>${candidates.length ? `<div class="tableWrap"><table class="dataTable requestUserTable"><thead><tr><th>Customer / login</th><th>Access</th><th>Movies</th><th>TV</th><th>Jellyfin servers</th><th>Sync</th><th>Request user</th><th>Login</th><th>Last sync</th><th>Problem</th><th class="right">Action</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">No managed request users yet.</div>'}</section>`;

    const action = `<div class="buttonRow"><a class="button secondary" href="/admin/request-plan-policy">Plan limits</a><form method="post" action="/admin/request-users/sync-all">${csrfInput(req)}<button class="button" type="submit" ${configured ? '' : 'disabled'}>Sync all users</button></form></div>`;
    const styles = '<style>.requestUserTable{min-width:1500px}.problemCell{max-width:300px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.metricValue.smallish{font-size:22px}</style>';
    return layout({
        siteName: runtimeSettings.siteName(),
        active: 'provisioning',
        title: 'Request User Sync',
        subtitle: 'One request identity, plan quota and lifecycle policy across every Jellyfin server',
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
            const message = `Request users synced: ${result.created} created, ${result.linked} active/linked, ${result.suspended} suspended, ${result.failed} failed.`;
            return res.redirect('/admin/request-users?message=' + encodeURIComponent(message));
        } catch (error) {
            return res.redirect('/admin/request-users?error=' + encodeURIComponent(error.message || 'Request user sync failed.'));
        }
    });
    router.post('/admin/request-users/:customerId/sync', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const result = await requestUsers.syncOneCustomer(req.params.customerId);
            const message = result.status === 'synced' ? 'Request user synced.' : result.status === 'suspended' ? 'Request access suspended; history preserved.' : `Request user ${result.status}.`;
            return res.redirect('/admin/request-users?message=' + encodeURIComponent(message));
        } catch (error) {
            return res.redirect('/admin/request-users?error=' + encodeURIComponent(error.message || 'Request user sync failed.'));
        }
    });
    return router;
}

module.exports = { createAdminRequestUsersRouter, page };
