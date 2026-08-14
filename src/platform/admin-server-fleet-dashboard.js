'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const { query } = require('../db');
const serversAdmin = require('./admin-servers');
const runtimeSettings = require('./runtime-settings');
const { esc, layout } = require('./admin-html');

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
function csrfInput(req) { return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`; }
function notice(value, kind = '') { return value ? `<div class="notice ${kind}">${esc(value)}</div>` : ''; }
function formatDate(value) {
    if (!value) return 'never';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? 'never' : parsed.toLocaleString();
}
function isoDate(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
function healthState(status) {
    if (status === 'healthy') return { cls: 'online', label: 'Online' };
    if (status === 'offline') return { cls: 'offline', label: 'Offline' };
    return { cls: 'unknown', label: 'Checking' };
}

async function dashboardRows() {
    const [servers, metrics] = await Promise.all([
        serversAdmin.serverList(),
        query(`
            SELECT server_id,total_users,active_streams,managed_streams,transcode_streams,
                   direct_stream_streams,direct_play_streams,paused_streams,
                   observed_at,last_error,error_at
            FROM jellyfin_server_metrics
        `)
    ]);
    const metricMap = new Map(metrics.rows.map(row => [String(row.server_id), row]));
    return servers.map(server => ({ ...server, fleet_metrics: metricMap.get(String(server.id)) || null }));
}

function serverRow(req, server) {
    const state = healthState(server.health_status);
    const metrics = server.fleet_metrics;
    const managedCustomers = Number(server.assigned_users || 0);
    const totalUsers = metrics?.total_users == null ? null : Number(metrics.total_users);
    const activeStreams = metrics?.active_streams == null ? null : Number(metrics.active_streams);
    const managedStreams = metrics?.managed_streams == null ? Number(server.active_streams || 0) : Number(metrics.managed_streams);
    const unmanagedStreams = activeStreams == null ? null : Math.max(0, activeStreams - managedStreams);
    const transcodes = metrics?.transcode_streams == null ? null : Number(metrics.transcode_streams);
    const capacity = server.max_users == null ? null : Number(server.max_users);

    const usersPrimary = totalUsers == null ? '—' : totalUsers.toLocaleString('en-GB');
    const userDetail = capacity == null
        ? `${managedCustomers.toLocaleString('en-GB')} managed`
        : `${managedCustomers.toLocaleString('en-GB')} managed / ${capacity.toLocaleString('en-GB')} placement capacity`;
    const streamsPrimary = activeStreams == null ? '—' : activeStreams.toLocaleString('en-GB');
    const streamParts = [`${managedStreams.toLocaleString('en-GB')} managed`];
    if (unmanagedStreams != null) streamParts.push(`${unmanagedStreams.toLocaleString('en-GB')} unmanaged`);
    if (transcodes != null) streamParts.push(`${transcodes.toLocaleString('en-GB')} transcoding`);

    return `<div class="compactServerRow" data-server-id="${esc(server.id)}">
        <div class="compactServerIdentity">
            <span class="serverStatusDot ${state.cls}" data-server-status-dot title="${esc(state.label)}"></span>
            <div class="compactServerName"><strong>${esc(server.name)}</strong><span>${esc(server.slug)} · ${esc(server.server_class)}</span></div>
        </div>
        <div class="compactServerMetric"><strong data-server-users>${esc(usersPrimary)}</strong><span data-server-users-detail>Jellyfin users · ${esc(userDetail)}</span></div>
        <div class="compactServerMetric"><strong data-server-streams>${esc(streamsPrimary)}</strong><span data-server-streams-detail>${esc(streamParts.join(' · '))}</span></div>
        <div class="compactServerCheck"><span data-server-health-text>${esc(state.label)}</span><small>Health <span data-server-last-check>${esc(formatDate(server.last_health_check))}</span></small><small>Metrics <span data-server-metrics-check>${esc(formatDate(metrics?.observed_at))}</span></small></div>
        <div class="compactServerActions">
            <a class="button secondary" href="/admin/servers/${esc(server.id)}/edit">Manage</a>
            <form method="post" action="/admin/servers/${esc(server.id)}/test">${csrfInput(req)}<button class="button secondary" type="submit">Test</button></form>
        </div>
    </div>`;
}

async function body(req) {
    await runtimeSettings.ensureLoaded();
    const rows = await dashboardRows();
    const healthMinutes = Math.max(1, Math.round(runtimeSettings.serverHealthIntervalMs() / 60000));
    return `${notice(req.query.message)}${notice(req.query.error, 'error')}
        <section class="section compactServerSection">
            <div class="sectionHead"><h2>Configured servers</h2><span class="muted">${rows.length} total · health every ${healthMinutes} min · live load sampled by activity worker</span></div>
            ${rows.length ? `<div class="compactServerRows">${rows.map(server => serverRow(req, server)).join('')}</div>` : '<div class="empty">No Jellyfin servers configured.</div>'}
        </section>
        <div class="notice">Live totals include every Jellyfin user and playback session on each server. “Managed” counts are the subset owned by CAPTaINFiN; stream enforcement only applies to that managed subset.</div>
        <script src="/js/admin-server-library-dashboard.js" defer></script>`;
}

async function statusJson(_req, res, next) {
    try {
        const rows = await dashboardRows();
        return res.json({
            servers: rows.map(server => {
                const metrics = server.fleet_metrics;
                const managedCustomers = Number(server.assigned_users || 0);
                const managedStreams = metrics?.managed_streams == null ? Number(server.active_streams || 0) : Number(metrics.managed_streams);
                const activeStreams = metrics?.active_streams == null ? null : Number(metrics.active_streams);
                return {
                    id: String(server.id),
                    status: server.health_status || 'unknown',
                    lastHealthCheck: isoDate(server.last_health_check),
                    totalUsers: metrics?.total_users == null ? null : Number(metrics.total_users),
                    managedCustomers,
                    maxUsers: server.max_users == null ? null : Number(server.max_users),
                    activeStreams,
                    managedStreams,
                    unmanagedStreams: activeStreams == null ? null : Math.max(0, activeStreams - managedStreams),
                    transcodeStreams: metrics?.transcode_streams == null ? null : Number(metrics.transcode_streams),
                    pausedStreams: metrics?.paused_streams == null ? null : Number(metrics.paused_streams),
                    metricsObservedAt: isoDate(metrics?.observed_at),
                    metricsError: metrics?.last_error || null
                };
            })
        });
    } catch (error) {
        return next(error);
    }
}

function createAdminServerFleetDashboardRouter() {
    const router = express.Router();
    router.use('/admin/servers', gate, noStore);
    router.get('/admin/servers/status.json', statusJson);
    router.get('/admin/servers', async (req, res, next) => {
        try {
            res.setHeader('Cache-Control', 'no-store, private, max-age=0');
            return res.send(layout({
                siteName: site(),
                active: 'servers',
                title: 'Servers',
                subtitle: 'Jellyfin availability, total load and CAPTaINFiN-managed load',
                body: await body(req),
                action: '<a class="button" href="/admin/servers/new">Add server</a>'
            }));
        } catch (error) { return next(error); }
    });
    return router;
}

module.exports = { createAdminServerFleetDashboardRouter, dashboardRows, statusJson };
