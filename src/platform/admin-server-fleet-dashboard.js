'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const { query } = require('../db');
const serversAdmin = require('./admin-servers');
const runtimeSettings = require('./runtime-settings');
const operations = require('./operations-settings');
const planServers = require('../jellyfin/plan-servers');
const userCapacity = require('../jellyfin/user-capacity');
const { esc, layout } = require('./admin-html');

function site() { return process.env.SITE_NAME || 'CAPTAiNFiN'; }
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
    if (!value) return 'Never';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? 'Never' : parsed.toLocaleString('en-GB');
}
function isoDate(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
function healthPill(status) {
    const value = String(status || 'unknown');
    const cls = value === 'healthy' ? 'good' : value === 'offline' ? 'bad' : 'warn';
    return `<span class="pill ${cls}">${esc(value)}</span>`;
}
function placementMode(server) { return String(server.placement_mode || 'active'); }
function placementLabel(mode) { return mode === 'drain' ? 'Drain' : mode === 'maintenance' ? 'Maintenance' : 'Active'; }
function placementEligible(server, settings) {
    return placementMode(server) === 'active' && server.allow_new_users === true && planServers.healthEligible(server, settings.placementHealthMode);
}
function placementReason(server, settings) {
    if (!server.allow_new_users) return 'New users off';
    if (placementMode(server) !== 'active') return placementLabel(placementMode(server));
    if (!planServers.healthEligible(server, settings.placementHealthMode)) return 'Health blocked';
    return 'Eligible';
}

async function dashboardRows() {
    const [servers, metrics, placement] = await Promise.all([
        serversAdmin.serverList(),
        query(`SELECT server_id,total_users,active_streams,managed_streams,transcode_streams,
                      direct_stream_streams,direct_play_streams,paused_streams,
                      observed_at,last_error,error_at
               FROM jellyfin_server_metrics`),
        query(`SELECT id,COALESCE(placement_mode,'active') placement_mode FROM jellyfin_servers`)
    ]);
    const canonicalServers = await userCapacity.decorateServers(servers);
    const metricMap = new Map(metrics.rows.map(row => [String(row.server_id), row]));
    const placementMap = new Map(placement.rows.map(row => [String(row.id), row.placement_mode]));
    return canonicalServers.map(server => ({
        ...server,
        placement_mode: placementMap.get(String(server.id)) || 'active',
        fleet_metrics: metricMap.get(String(server.id)) || null
    }));
}

function metricNumber(server, key, fallback = 0) {
    return server.fleet_metrics?.[key] == null ? Number(fallback || 0) : Number(server.fleet_metrics[key] || 0);
}
function fleetSummary(rows, settings) {
    const enabled = rows.filter(row => row.enabled !== false);
    const healthy = enabled.filter(row => row.health_status === 'healthy').length;
    const offline = enabled.filter(row => row.health_status === 'offline').length;
    const degraded = enabled.filter(row => row.health_status === 'degraded').length;
    const eligible = enabled.filter(row => placementEligible(row, settings)).length;
    const managed = enabled.reduce((sum, row) => sum + Number(row.assigned_users || 0), 0);
    const capacity = enabled.reduce((sum, row) => sum + Number(row.max_users || 0), 0);
    const streams = enabled.reduce((sum, row) => sum + metricNumber(row, 'active_streams', row.active_streams), 0);
    return { total: enabled.length, healthy, offline, degraded, eligible, managed, capacity, streams };
}
function overview(summary) {
    return `<div class="serverControlOverview" data-admin-surface="overview">
        <div><span>Servers</span><strong>${summary.total}</strong><small>${summary.healthy} healthy</small></div>
        <div><span>Placement ready</span><strong>${summary.eligible}</strong><small>${summary.total - summary.eligible} excluded</small></div>
        <div><span>Customer capacity</span><strong>${summary.capacity ? `${summary.managed}/${summary.capacity}` : 'Not set'}</strong><small>One managed customer = one place</small></div>
        <div><span>Live streams</span><strong>${summary.streams}</strong><small>${summary.offline + summary.degraded} server issue${summary.offline + summary.degraded === 1 ? '' : 's'}</small></div>
    </div>`;
}

function placementForm(req, server) {
    const mode = placementMode(server);
    return `<form class="serverInlineControl" method="post" action="/admin/servers/operations/server/${esc(server.id)}/placement-mode">
        ${csrfInput(req)}
        <label class="srOnly" for="placement-${esc(server.id)}">Placement mode for ${esc(server.name)}</label>
        <select id="placement-${esc(server.id)}" class="input" name="mode" aria-label="Placement mode for ${esc(server.name)}">
            <option value="active" ${mode === 'active' ? 'selected' : ''}>Active</option>
            <option value="drain" ${mode === 'drain' ? 'selected' : ''}>Drain</option>
            <option value="maintenance" ${mode === 'maintenance' ? 'selected' : ''}>Maintenance</option>
        </select>
        <button class="button secondary btn-sm" type="submit">Save</button>
    </form>`;
}
function scanForm(req, server) {
    return `<form method="post" action="/admin/libraries/${esc(server.id)}/refresh">
        ${csrfInput(req)}<button class="button secondary btn-sm" type="submit">Scan</button>
    </form>`;
}
function testForm(req, server) {
    return `<form method="post" action="/admin/servers/${esc(server.id)}/test">
        ${csrfInput(req)}<button class="button secondary btn-sm" type="submit">Test</button>
    </form>`;
}
function serverTable(req, rows, settings) {
    if (!rows.length) return '<div class="empty">No Jellyfin servers configured.</div>';
    return `<div class="tableWrap serverControlTableWrap"><table class="dataTable responsiveTable serverControlTable">
        <thead><tr><th>Server</th><th>Health</th><th>Customer capacity</th><th>Live</th><th>Placement</th><th>Libraries</th><th>Actions</th></tr></thead>
        <tbody>${rows.map(server => {
            const managed = Number(server.assigned_users || 0), max = server.max_users == null ? null : Number(server.max_users);
            const live = metricNumber(server, 'active_streams', server.active_streams);
            const reason = placementReason(server, settings), eligible = reason === 'Eligible';
            const capacityText=max==null?`${managed} users`:`${managed}/${max}${managed>max?` · OVER +${managed-max}`:managed===max?' · FULL':` · ${Math.max(0,max-managed)} free`}`;
            return `<tr id="server-${esc(server.id)}">
                <td class="serverControlIdentity"><strong>${esc(server.name)}</strong><small>${esc(server.server_class)}${server.location ? ` · ${esc(server.location)}` : ''} · priority ${esc(server.priority)}</small></td>
                <td>${healthPill(server.health_status)}<small>Checked ${esc(formatDate(server.last_health_check))}</small></td>
                <td><strong>${esc(capacityText)}</strong><small>Managed customer users only</small></td>
                <td><strong>${live}</strong><small>${metricNumber(server, 'transcode_streams', 0)} transcoding</small></td>
                <td><div class="serverPlacementState"><span class="pill ${eligible ? 'good' : reason === 'Health blocked' ? 'bad' : 'warn'}">${esc(reason)}</span>${placementForm(req, server)}</div></td>
                <td><div class="serverLibraryAction"><span>Jellyfin library</span>${scanForm(req, server)}</div></td>
                <td><div class="serverRowActions"><a class="button secondary btn-sm" href="/admin/servers/${esc(server.id)}/edit">Manage</a>${testForm(req, server)}<a class="button secondary btn-sm" href="/admin/servers/${esc(server.id)}/users">Users</a></div></td>
            </tr>`;
        }).join('')}</tbody>
    </table></div>`;
}

async function pageData(_req) {
    const [rows, settings] = await Promise.all([
        dashboardRows(),
        operations.get()
    ]);
    return { rows, settings };
}
async function body(req) {
    await runtimeSettings.ensureLoaded();
    const data = await pageData(req), summary = fleetSummary(data.rows, data.settings);
    return `${notice(req.query.message)}${notice(req.query.error, 'error')}${overview(summary)}
        <section class="section serverControlSection" id="placement" data-admin-surface="control">
            <div class="sectionHead"><div><h2>Servers</h2><p>Health, customer-user capacity, placement and library maintenance in one place.</p></div><span class="muted">${data.rows.length} configured</span></div>
            <div class="serverControlHint"><strong>Capacity:</strong> one managed Jellyfin customer uses one place, regardless of that customer's concurrent-stream plan. <strong>Placement:</strong> Active can receive new customers; Drain and Maintenance stop new assignments without moving existing users.</div>
            ${serverTable(req, data.rows, data.settings)}
            <div class="securityNote">API keys stay write-only. Library Scan asks Jellyfin to refresh its library; it does not change plan library access.</div>
        </section>`;
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
                const maxUsers = server.max_users == null ? null : Number(server.max_users);
                return {
                    id: String(server.id), status: server.health_status || 'unknown',
                    lastHealthCheck: isoDate(server.last_health_check), totalUsers: metrics?.total_users == null ? null : Number(metrics.total_users),
                    managedCustomers, maxUsers, userCapacity: maxUsers, activeStreams, managedStreams,
                    unmanagedStreams: activeStreams == null ? null : Math.max(0, activeStreams - managedStreams),
                    transcodeStreams: metrics?.transcode_streams == null ? null : Number(metrics.transcode_streams),
                    pausedStreams: metrics?.paused_streams == null ? null : Number(metrics.paused_streams),
                    metricsObservedAt: isoDate(metrics?.observed_at), metricsError: metrics?.last_error || null
                };
            })
        });
    } catch (error) { return next(error); }
}

function createAdminServerFleetDashboardRouter() {
    const router = express.Router();
    router.use('/admin/servers', gate, noStore);
    router.get('/admin/servers/status.json', statusJson);
    router.get('/admin/servers', async (req, res, next) => {
        try {
            return res.send(layout({ siteName: site(), active: 'servers', title: 'Servers',
                subtitle: 'Jellyfin fleet health, placement and customer capacity', body: await body(req),
                action: '<a class="button" href="/admin/servers/new">Add server</a>' }));
        } catch (error) { return next(error); }
    });
    return router;
}

module.exports = { createAdminServerFleetDashboardRouter, dashboardRows, statusJson, pageData, placementEligible };