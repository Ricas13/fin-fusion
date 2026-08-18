'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const { query } = require('../db');
const serversAdmin = require('./admin-servers');
const runtimeSettings = require('./runtime-settings');
const { esc, layout } = require('./admin-html');
const graphics=require('./admin-section-graphics');

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

function metricNumber(server,key,fallback=0){return server.fleet_metrics?.[key]==null?Number(fallback||0):Number(server.fleet_metrics[key]||0)}
function serverOverview(rows){
    const total=rows.length,healthy=rows.filter(row=>row.health_status==='healthy').length,offline=rows.filter(row=>row.health_status==='offline').length,degraded=rows.filter(row=>row.health_status==='degraded').length;
    const managed=rows.reduce((sum,row)=>sum+Number(row.assigned_users||0),0),capacity=rows.reduce((sum,row)=>sum+Number(row.max_users||0),0);
    const activeStreams=rows.reduce((sum,row)=>sum+metricNumber(row,'active_streams',row.active_streams),0),managedStreams=rows.reduce((sum,row)=>sum+metricNumber(row,'managed_streams',row.active_streams),0),transcodes=rows.reduce((sum,row)=>sum+metricNumber(row,'transcode_streams',0),0);
    const topLoad=rows.map(row=>({name:row.name,count:metricNumber(row,'active_streams',row.active_streams)})).sort((a,b)=>b.count-a.count).slice(0,6);
    return `${graphics.hero({title:'Fleet health',subtitle:'Live Jellyfin availability, placement capacity and stream pressure across the CAPTAiNFiN-managed fleet.',tone:offline?'warn':'blue',stats:[
        graphics.stat({label:'Servers',value:graphics.number(total),meta:`${graphics.number(healthy)} healthy`,tone:offline?'warn':'good'}),
        graphics.stat({label:'Live streams',value:graphics.number(activeStreams),meta:`${graphics.number(managedStreams)} managed`,tone:'blue',href:'/admin/activity'}),
        graphics.stat({label:'Transcodes',value:graphics.number(transcodes),meta:'live transcoding load',tone:transcodes?'violet':'good'}),
        graphics.stat({label:'Offline/degraded',value:graphics.number(offline+degraded),meta:`${graphics.number(offline)} offline`,tone:offline||degraded?'warn':'good',href:'/admin/attention'})
    ],meters:[graphics.meter({label:'Placement capacity used',value:managed,max:capacity||Math.max(managed,1),tone:capacity&&managed/capacity>.85?'warn':'good',meta:capacity?`${graphics.number(managed)} managed users / ${graphics.number(capacity)} configured capacity`:'No explicit max-user capacity set'})],actions:'<a class="button secondary" href="/admin/servers/new">Add server</a><a class="button secondary" href="/admin/activity">Playback operations</a>'})}${graphics.insightGrid([
        {title:'Stream load',subtitle:'Current active streams by server',value:graphics.number(activeStreams),body:graphics.bars(topLoad),tone:'blue',href:'/admin/activity',linkLabel:'Open playback'},
        {title:'Health states',subtitle:'Enabled server status',value:`${graphics.number(healthy)} / ${graphics.number(total)}`,body:graphics.bars([{name:'Healthy',count:healthy},{name:'Degraded',count:degraded},{name:'Offline',count:offline}]),tone:offline?'warn':'good',href:'/admin/attention',linkLabel:'Review issues'},
        {title:'Customer placement',subtitle:'Managed accounts across servers',value:graphics.number(managed),body:graphics.bars(rows.map(row=>({name:row.name,count:Number(row.assigned_users||0)})).sort((a,b)=>b.count-a.count).slice(0,6)),tone:'violet',href:'/admin/users',linkLabel:'Open customers'}
    ])}`;
}
async function body(req) {
    await runtimeSettings.ensureLoaded();
    const rows = await dashboardRows();
    const healthMinutes = Math.max(1, Math.round(runtimeSettings.serverHealthIntervalMs() / 60000));
    return `${notice(req.query.message)}${notice(req.query.error, 'error')}${serverOverview(rows)}
        <section class="section compactServerSection">
            <div class="sectionHead"><h2>Configured servers</h2><span class="muted">${rows.length} total · health every ${healthMinutes} min · live load sampled by activity worker</span></div>
            ${rows.length ? `<div class="compactServerRows">${rows.map(server => serverRow(req, server)).join('')}</div>` : '<div class="empty">No Jellyfin servers configured.</div>'}
        </section>
        <div class="notice">Live totals include every Jellyfin user and playback session on each server. “Managed” counts are the subset owned by CAPTAiNFiN; stream enforcement only applies to that managed subset.</div>
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
                subtitle: 'Jellyfin availability, total load and CAPTAiNFiN-managed load',
                body: await body(req),
                action: '<a class="button" href="/admin/servers/new">Add server</a>'
            }));
        } catch (error) { return next(error); }
    });
    return router;
}

module.exports = { createAdminServerFleetDashboardRouter, dashboardRows, statusJson };
