'use strict';

const express = require('express');
const { query } = require('../db');
const csrf = require('../auth/csrf');
const placement = require('../jellyfin/placement');
const { esc, layout } = require('./admin-html');
const { planSubnav } = require('./admin-plans');

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
function healthLabel(value) {
    if (value === 'healthy') return 'Online';
    if (value === 'offline') return 'Offline';
    if (value === 'degraded') return 'Degraded';
    return 'Checking';
}
function healthClass(value) {
    if (value === 'healthy') return 'good';
    if (value === 'offline') return 'bad';
    return '';
}
function dt(value) {
    if (!value) return '—';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
}

async function planById(id) {
    const result = await query('SELECT * FROM plans WHERE id=$1', [id]);
    return result.rows[0] || null;
}

async function placementData(plan) {
    await placement.refreshFleetSnapshot().catch(() => {});
    const result = await query(`
        SELECT js.id,js.name,js.slug,js.server_class,js.location,js.enabled,js.allow_new_users,
               js.trial_enabled,js.paid_enabled,js.priority,js.max_users,js.health_status,
               COUNT(DISTINCT ja.id)::int AS assigned_users,
               COUNT(DISTINCT aps.jellyfin_session_id)::int AS active_streams,
               pse.weight AS placement_weight,
               (pse.server_id IS NOT NULL) AS selected,
               m.total_users AS fleet_users,m.active_streams AS fleet_streams,
               m.managed_streams AS fleet_managed_streams,m.observed_at AS fleet_observed_at,
               m.last_error AS fleet_error
        FROM jellyfin_servers js
        LEFT JOIN plan_server_eligibility pse
               ON pse.plan_id=$2 AND pse.server_id=js.id
        LEFT JOIN jellyfin_accounts ja
               ON ja.server_id=js.id AND ja.disabled=FALSE
        LEFT JOIN active_playback_sessions aps
               ON aps.server_id=js.id
        LEFT JOIN jellyfin_server_metrics m ON m.server_id=js.id
        WHERE js.server_class=$1
        GROUP BY js.id,pse.weight,pse.server_id,m.server_id,m.total_users,m.active_streams,m.managed_streams,m.observed_at,m.last_error
        ORDER BY js.priority,js.name
    `, [plan.server_class, plan.id]);
    const restricted = result.rows.some(server => server.selected);
    return { servers: result.rows, restricted };
}

function strategyOptions(selected) {
    const rows = [
        ['balanced', 'Balanced (recommended)', 'Health, real Jellyfin capacity, live streams, total users and priority'],
        ['lowest_customers', 'Lowest total user count', 'Prefer the eligible server with the fewest actual Jellyfin users'],
        ['lowest_streams', 'Lowest live streams', 'Prefer the eligible server with the fewest actual playback sessions'],
        ['weighted', 'Weighted distribution', 'Split new accounts using server weights, excluding servers already at capacity'],
        ['manual', 'Pinned server', 'Always use one selected server unless its real Jellyfin user capacity is full']
    ];
    return rows.map(([value, label, help]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${esc(label)} — ${esc(help)}</option>`).join('');
}

function serverRows(data) {
    return data.servers.map(server => {
        const checked = data.restricted && server.selected;
        const disabled = !server.enabled || !server.allow_new_users;
        const load = placement.fleetLoad(server);
        const full = placement.atCapacity(server);
        const max = server.max_users == null ? 'No limit' : Number(server.max_users).toLocaleString('en-GB');
        const existingWeight = server.placement_weight == null ? 100 : Number(server.placement_weight);
        const source = load.source === 'fleet'
            ? `<span class="pill good">Live sample</span><div class="subText">${esc(dt(load.observedAt))}</div>`
            : `<span class="pill warn">Managed fallback</span><div class="subText">Waiting for a fresh fleet sample</div>`;
        const capacity = full ? '<span class="pill bad">Full</span>' : '<span class="pill good">Available</span>';
        return `<tr>
            <td><input type="checkbox" name="serverIds" value="${esc(server.id)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}></td>
            <td><strong>${esc(server.name)}</strong><div class="muted">${esc(server.slug)}${server.location ? ` · ${esc(server.location)}` : ''}</div></td>
            <td><span class="pill ${healthClass(server.health_status)}">${esc(healthLabel(server.health_status))}</span><div class="subText">${capacity}</div></td>
            <td><strong>${load.users.toLocaleString('en-GB')}</strong> / ${esc(max)}<div class="subText">${load.managedUsers.toLocaleString('en-GB')} CAPTAiNFiN managed</div></td>
            <td><strong>${load.streams.toLocaleString('en-GB')}</strong><div class="subText">${load.managedStreams.toLocaleString('en-GB')} managed</div></td>
            <td>${source}</td>
            <td><input class="input" style="max-width:7rem" type="number" min="1" max="10000" name="weight_${esc(server.id)}" value="${esc(existingWeight)}" ${disabled ? 'disabled' : ''}></td>
        </tr>`;
    }).join('');
}

function page(req, plan, data) {
    const strategy = placement.normalizeStrategy(plan.placement_strategy);
    const poolMode = data.restricted ? 'selected' : 'all';
    const empty = !data.servers.length;
    const body = `${notice(req.query.message)}${notice(req.query.error, 'error')}${planSubnav(plan.id, 'placement')}
        <section class="section">
            <div class="sectionHead"><div><h2>Fleet-aware server placement</h2><div class="settings-hint">New accounts are placed using the real Jellyfin user and playback load when a fresh fleet sample is available.</div></div></div>
            <div class="notice">Existing customers are never moved automatically. If fleet metrics become stale or unavailable, placement safely falls back to CAPTAiNFiN-managed counts rather than blocking provisioning.</div>
            <form class="formPanel" method="post" action="/admin/plans/${esc(plan.id)}/placement">
                ${csrfInput(req)}
                <div class="formGroup"><label>Placement strategy</label><select class="input" name="placementStrategy">${strategyOptions(strategy)}</select></div>
                <div class="formGroup">
                    <label>Eligible server pool</label>
                    <label class="toggleRow"><input type="radio" name="poolMode" value="all" ${poolMode === 'all' ? 'checked' : ''}><span>All available <strong>${esc(plan.server_class)}</strong> servers</span></label>
                    <label class="toggleRow"><input type="radio" name="poolMode" value="selected" ${poolMode === 'selected' ? 'checked' : ''} ${empty ? 'disabled' : ''}><span>Only selected servers below</span></label>
                </div>
                ${empty ? `<div class="empty">No ${esc(plan.server_class)} Jellyfin servers are configured yet. <a href="/admin/servers/new">Add a server</a>.</div>` : `
                <div class="tableWrap"><table class="dataTable fleetPlacementTable">
                    <thead><tr><th>Use</th><th>Server</th><th>Health</th><th>Total users / capacity</th><th>Live streams</th><th>Load source</th><th>Weight</th></tr></thead>
                    <tbody>${serverRows(data)}</tbody>
                </table></div>
                <div class="inlineHelp">Maximum users is now treated as real Jellyfin server capacity when a fresh fleet sample exists. Legacy/unmanaged users therefore consume capacity too. Weighted distribution still respects capacity before applying weights.</div>`}
                <div class="buttonRow"><button class="button">Save placement</button></div>
            </form>
        </section><style>.fleetPlacementTable{min-width:1120px}</style>`;
    return layout({ siteName: site(), active: 'plans', title: `${plan.name} · Placement`, subtitle: `${plan.server_class} server pool`, body });
}

function createAdminPlanPlacementFleetRouter() {
    const router = express.Router();
    router.use('/admin/plans', gate, noStore);
    router.get('/admin/plans/:id/placement', async (req, res, next) => {
        try {
            const plan = await planById(req.params.id);
            if (!plan) return res.status(404).send('Plan not found');
            return res.send(page(req, plan, await placementData(plan)));
        } catch (error) { return next(error); }
    });
    return router;
}

module.exports = { createAdminPlanPlacementFleetRouter, placementData, page };
