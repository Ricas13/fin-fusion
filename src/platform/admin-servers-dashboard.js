'use strict';

const express = require('express');
const { query } = require('../db');
const { layout, esc } = require('./admin-html');
const runtimeSettings = require('./runtime-settings');
const { dashboardRange } = require('./admin-dashboard-analytics');
const fleetDashboard = require('./admin-server-fleet-dashboard');
const libraryDashboard = require('./admin-server-library-dashboard');
const registry = require('./admin-dashboard-registry');
const widgets = require('./admin-dashboard-widgets');
const { renderWidgetGrid } = require('./admin-dashboard-page');
const { rangeControls } = require('./admin-dashboard-view');
const { number } = require('./admin-dashboard-format');
const ui = require('./admin-ui');

function gate(req, res, next) {
    return req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId ? next() : res.redirect('/login?session=expired');
}
function noStore(_req, res, next) { res.setHeader('Cache-Control', 'no-store, private, max-age=0'); res.setHeader('Pragma', 'no-cache'); next(); }

function fleetMetric(row, key, fallback = 0) {
    return row.fleet_metrics?.[key] == null ? Number(fallback || 0) : Number(row.fleet_metrics[key] || 0);
}

async function playbackMethodBreakdown(range) {
    const result = await query(`
        SELECT playback_method name,COUNT(*)::int count
        FROM playback_history WHERE started_at>=$1 AND started_at<$2
        GROUP BY 1 ORDER BY 2 DESC
    `, [range.start, range.end]);
    return result.rows;
}

// Live-only: playback_history has no session id/API key/token columns, and
// this intentionally never selects any -- only customer-facing identity and
// playback metadata.
async function currentActiveStreams() {
    const result = await query(`
        SELECT ph.id,ph.item_name,ph.item_type,ph.playback_method,ph.started_at,ph.client_name,
               js.name server_name,
               COALESCE(c.display_name,u.username,c.email,'Customer') customer_name,c.id customer_id,
               (SELECT p.streams FROM subscriptions sub JOIN plans p ON p.id=sub.plan_id
                WHERE sub.customer_id=c.id AND sub.status IN('active','trialing') AND sub.current_period_end>NOW()
                ORDER BY sub.current_period_end DESC LIMIT 1) stream_limit
        FROM playback_history ph
        JOIN jellyfin_servers js ON js.id=ph.server_id
        LEFT JOIN customers c ON c.id=ph.customer_id
        LEFT JOIN app_users u ON u.id=c.user_id
        WHERE ph.ended_at IS NULL
        ORDER BY ph.started_at ASC
        LIMIT 50
    `);
    return result.rows;
}

// Live Jellyfin API call (per configured library) -- intentionally kept out
// of buildContext() so it only runs when this lazy widget's fragment is
// actually requested, not on every dashboard load or every other lazy
// widget's fragment fetch.
async function libraryTotals() {
    const data = await libraryDashboard.librariesData({ query: {} });
    let totalItems = 0, knownLibraries = 0, totalLibraries = 0;
    const byType = new Map();
    for (const group of data.groups || []) {
        for (const lib of group.libs || []) {
            totalLibraries++;
            if (lib.itemCount == null) continue;
            knownLibraries++;
            totalItems += Number(lib.itemCount);
            const typeLabel = libraryDashboard.libraryTypeLabel(lib.CollectionType);
            byType.set(typeLabel, (byType.get(typeLabel) || 0) + Number(lib.itemCount));
        }
    }
    return {
        totalItems, totalLibraries, knownLibraries,
        byType: [...byType.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
    };
}

async function buildContext(req) {
    const range = dashboardRange(req.query || {});
    const [rows, playbackMethods] = await Promise.all([
        fleetDashboard.dashboardRows(),
        playbackMethodBreakdown(range)
    ]);
    return { range, data: { rows, playbackMethods } };
}
registry.registerContextBuilder('servers', buildContext);

// Default desktop rows intentionally add up to the full 12-column grid:
// 6+6, 4+4+4, 6+6, then a full-width live-stream table. This keeps the
// fleet dashboard visually ordered without taking customization away.
registry.register('servers', 'concurrentStreamsByServer', {
    title: 'Concurrent streams by server', subtitle: 'Live snapshot only -- CAPTAiNFiN does not collect a historical concurrent-stream time series, so this does not follow the selected timeframe.',
    defaultOrder: 1, defaultSpan: 6,
    render: async ctx => {
        const rows = ctx.data.rows.map(row => ({ label: row.name, count: fleetMetric(row, 'active_streams', row.active_streams) }));
        return rows.length ? widgets.barChart(rows, 'count', undefined, { orientation: 'horizontal' }) : widgets.emptyState('No Jellyfin servers configured.');
    }
});
registry.register('servers', 'playbackMethodBreakdown', {
    title: 'Playback method', subtitle: 'Only directplay, directstream, transcode and unknown are tracked -- there is no audio-vs-video transcode distinction.',
    defaultOrder: 2, defaultSpan: 6,
    render: async ctx => ctx.data.playbackMethods.length ? widgets.donutChart(ctx.data.playbackMethods) : widgets.emptyState('No playback sessions recorded in this period.')
});
registry.register('servers', 'capacityUtilization', {
    title: 'Capacity utilization', defaultOrder: 3, defaultSpan: 4,
    render: async ctx => {
        const managed = ctx.data.rows.reduce((sum, row) => sum + Number(row.assigned_users || 0), 0);
        const capacity = ctx.data.rows.reduce((sum, row) => sum + Number(row.max_users || 0), 0);
        return widgets.kpiCard({
            key: 'capacityUtilization', label: 'Capacity utilization',
            value: capacity ? `${number(Math.round(managed / capacity * 100))}%` : '—',
            meta: capacity ? `${number(managed)} managed / ${number(capacity)} capacity` : 'No explicit max-user capacity set',
            href: '/admin/servers'
        });
    }
});
registry.register('servers', 'playbackQuality', {
    title: 'Playback quality distribution', defaultOrder: 4, defaultSpan: 4,
    render: async () => widgets.emptyState('CAPTAiNFiN does not currently collect playback resolution/quality data.')
});
registry.register('servers', 'serverStatus', {
    title: 'Server status', subtitle: 'Live status only -- there is not enough retained history to compute an uptime percentage.',
    defaultOrder: 5, defaultSpan: 4,
    render: async ctx => {
        if (!ctx.data.rows.length) return widgets.emptyState('No Jellyfin servers configured.');
        return widgets.healthWidget(ctx.data.rows.map(row => ({
            label: row.name,
            status: row.health_status === 'healthy' ? 'good' : row.health_status === 'offline' ? 'bad' : 'warn',
            detail: row.health_status === 'healthy' ? 'Online' : row.health_status === 'offline' ? 'Offline' : 'Checking',
            href: `/admin/servers/${row.id}/edit`
        })));
    }
});
registry.register('servers', 'currentErrors', {
    title: 'Current server errors', subtitle: 'Most recent error per server -- error-trend history is not collected.',
    defaultOrder: 6, defaultSpan: 6,
    render: async ctx => {
        const withErrors = ctx.data.rows.filter(row => row.fleet_metrics?.last_error);
        if (!withErrors.length) return widgets.emptyState('No server has reported an error recently.');
        return widgets.statusTable(withErrors, [
            { key: 'name', label: 'Server', render: row => `<a href="/admin/servers/${esc(row.id)}/edit">${esc(row.name)}</a>` },
            { key: 'last_error', label: 'Last error', render: row => esc(row.fleet_metrics.last_error) },
            { key: 'error_at', label: 'When', render: row => esc(row.fleet_metrics.error_at ? new Date(row.fleet_metrics.error_at).toLocaleString('en-GB') : '—') }
        ]);
    }
});
registry.register('servers', 'libraryTotals', {
    title: 'Library totals', subtitle: 'Live counts from Jellyfin. No historical sparkline is shown -- that would need a new metrics-history table.',
    defaultOrder: 7, defaultSpan: 6, lazy: true,
    render: async () => {
        const totals = await libraryTotals();
        if (!totals.totalLibraries) return widgets.emptyState('No Jellyfin libraries found.');
        const stat = totals.knownLibraries < totals.totalLibraries
            ? `<p class="analyticsFootnote">${number(totals.knownLibraries)} of ${number(totals.totalLibraries)} libraries reported a count; the rest were unreachable.</p>` : '';
        return `${stat}${widgets.kpiCard({ key: 'libraryItems', label: 'Total items', value: number(totals.totalItems) })}${totals.byType.length ? widgets.barChart(totals.byType, 'count', undefined, { orientation: 'horizontal' }) : ''}`;
    }
});
registry.register('servers', 'currentActiveStreams', {
    title: 'Current active streams', defaultOrder: 8, defaultSpan: 12, lazy: true,
    render: async () => {
        const rows = await currentActiveStreams();
        if (!rows.length) return widgets.emptyState('No active playback sessions right now.');
        return widgets.statusTable(rows, [
            { key: 'customer_name', label: 'Customer', render: row => row.customer_id ? `<a href="/admin/users/${esc(row.customer_id)}">${esc(row.customer_name)}</a>` : esc(row.customer_name) },
            { key: 'server_name', label: 'Server', render: row => esc(row.server_name) },
            { key: 'item_name', label: 'Media', render: row => esc(row.item_name || row.item_type || 'Unknown') },
            { key: 'playback_method', label: 'Playback', render: row => esc(row.playback_method) },
            { key: 'started_at', label: 'Duration', align: 'numeric', render: row => esc(formatDuration(row.started_at)) }
        ]);
    }
});

function formatDuration(startedAt) {
    const ms = Date.now() - new Date(startedAt).getTime();
    const minutes = Math.max(0, Math.round(ms / 60000));
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function fleetSummary(rows) {
    const total = rows.length;
    const offline = rows.filter(row => row.health_status === 'offline').length;
    const degraded = rows.filter(row => row.health_status === 'degraded').length;
    const healthy = rows.filter(row => row.health_status === 'healthy').length;
    const streams = rows.reduce((sum, row) => sum + fleetMetric(row, 'active_streams', row.active_streams), 0);
    const managed = rows.reduce((sum, row) => sum + Number(row.assigned_users || 0), 0);
    const capacity = rows.reduce((sum, row) => sum + Number(row.max_users || 0), 0);
    const capacityPercent = capacity ? Math.round(managed / capacity * 100) : null;
    return { total, offline, degraded, healthy, streams, managed, capacity, capacityPercent };
}

function selectedServerResolution(req, rows) {
    const serverId = String(req.query.server || '').trim();
    if (!serverId) return '';
    const server = rows.find(row => String(row.id) === serverId);
    if (!server) return ui.resolutionCard({ tone: 'info', badge: 'Server context', title: 'That server is no longer in the active fleet', body: 'It may have been disabled or removed since the issue was raised.', actionHtml: '<a class="button secondary" href="/admin/servers/dashboard">Back to fleet overview</a>' });
    const healthy = server.health_status === 'healthy';
    const tone = healthy ? 'good' : server.health_status === 'offline' ? 'bad' : 'warn';
    return ui.resolutionCard({
        tone,
        badge: healthy ? 'Already resolved' : 'You came here to fix this',
        title: healthy ? `${server.name} is healthy again` : `${server.name} is ${server.health_status || 'not healthy'}`,
        body: healthy ? 'The latest fleet check reports this server as online.' : 'Open this server’s connection and placement settings to correct the cause, then return here to confirm health.',
        reason: server.fleet_metrics?.last_error || `Last health check ${server.last_health_check ? new Date(server.last_health_check).toLocaleString('en-GB') : 'has not completed'}.`,
        actionHtml: healthy ? '<a class="button secondary" href="/admin/servers/dashboard">Back to fleet overview</a>' : `<a class="button" href="/admin/servers/${esc(server.id)}/edit">Open ${esc(server.name)} settings</a>`,
        secondaryHtml: healthy ? '' : '<a class="button secondary" href="/admin/servers">Server list</a>'
    });
}

function fleetHero(rows) {
    const s = fleetSummary(rows);
    const firstProblem = rows.find(row => row.health_status === 'offline') || rows.find(row => row.health_status === 'degraded');
    const tone = s.offline ? 'bad' : s.degraded ? 'warn' : s.total ? 'streaming' : 'info';
    const title = !s.total ? 'No Jellyfin servers configured' : s.offline ? `${s.offline} ${s.offline === 1 ? 'server is' : 'servers are'} offline` : s.degraded ? `${s.degraded} ${s.degraded === 1 ? 'server needs' : 'servers need'} review` : 'Jellyfin fleet is healthy';
    const next = !s.total ? 'Add the first Jellyfin server.' : firstProblem ? `Fix ${firstProblem.name} before routine fleet work.` : s.capacityPercent != null && s.capacityPercent >= 85 ? 'Fleet is healthy, but capacity is getting tight. Review server capacity.' : 'No server intervention is required.';
    const actions = firstProblem
        ? `<a class="button" href="/admin/servers/${esc(firstProblem.id)}/edit">Fix ${esc(firstProblem.name)}</a><a class="button secondary" href="/admin/servers">Server list</a>`
        : !s.total ? '<a class="button" href="/admin/servers/new">Add Jellyfin server</a>' : '<a class="button secondary" href="/admin/servers">Manage servers</a>';
    return ui.operatorHero({
        tone,
        eyebrow: 'Jellyfin fleet control room',
        title,
        body: s.total ? 'Health, live playback and capacity are summarized first. Detailed analytics are below.' : 'CAPTAiNFiN cannot provide or sell Jellyfin access until a server is configured.',
        statusLabel: s.offline ? 'Action required' : s.degraded ? 'Review needed' : s.total ? 'Fleet online' : 'Setup required',
        next,
        facts: [
            { label: 'Healthy servers', value: `${s.healthy} / ${s.total}`, detail: s.offline ? `${s.offline} offline` : s.degraded ? `${s.degraded} degraded` : 'all responding normally' },
            { label: 'Live streams', value: number(s.streams), detail: 'current playback sessions' },
            { label: 'Managed users', value: number(s.managed), detail: 'assigned across fleet' },
            { label: 'Capacity', value: s.capacityPercent == null ? 'Not set' : `${s.capacityPercent}%`, detail: s.capacity ? `${number(s.managed)} / ${number(s.capacity)} users` : 'no explicit max-user capacity' }
        ],
        actionsHtml: actions
    });
}

async function renderPage(req) {
    const ctx = await buildContext(req);
    const widgetGrid = await renderWidgetGrid('servers', req, ctx);
    const body_html = `${selectedServerResolution(req, ctx.data.rows)}${fleetHero(ctx.data.rows)}${rangeControls(ctx.range,'/admin/servers/dashboard')}${widgetGrid}`;
    return layout({ siteName: runtimeSettings.siteName(), active: 'servers-dashboard', title: 'Servers dashboard', subtitle: `Fleet health first, then playback and library analytics · ${ctx.range.label}`, body: body_html, action: '<a class="button secondary" href="/admin/servers">Server list</a>' });
}

function createAdminServersDashboardRouter() {
    const router = express.Router();
    router.use('/admin/servers/dashboard', gate, noStore);
    router.get('/admin/servers/dashboard', async (req, res, next) => {
        try { return res.send(await renderPage(req)); } catch (error) { next(error); }
    });
    return router;
}

module.exports = { createAdminServersDashboardRouter, buildContext, libraryTotals, currentActiveStreams, fleetSummary, fleetHero, selectedServerResolution };