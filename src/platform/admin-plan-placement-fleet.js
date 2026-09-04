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
function jellyfinPlan(plan){return ['jellyfin','bundle'].includes(String(plan?.service_type||'jellyfin'));}

async function planById(id) {
    const result = await query('SELECT * FROM plans WHERE id=$1', [id]);
    return result.rows[0] || null;
}

async function placementData(plan) {
    if(!jellyfinPlan(plan))return {servers:[],restricted:false};
    await placement.refreshFleetSnapshot().catch(() => {});
    const result = await query(`
        SELECT js.id,js.name,js.slug,js.server_class,js.location,js.enabled,js.allow_new_users,
               js.trial_enabled,js.paid_enabled,js.priority,js.max_users,js.health_status,
               COUNT(DISTINCT ja.customer_id)::int AS assigned_users,
               COUNT(DISTINCT aps.jellyfin_session_id)::int AS active_streams,
               pse.weight AS placement_weight,
               (pse.server_id IS NOT NULL) AS selected,
               m.active_streams AS fleet_streams,m.managed_streams AS fleet_managed_streams,
               m.observed_at AS fleet_observed_at,m.last_error AS fleet_error
        FROM jellyfin_servers js
        LEFT JOIN plan_server_eligibility pse
               ON pse.plan_id=$2 AND pse.server_id=js.id
        LEFT JOIN jellyfin_accounts ja
               ON ja.server_id=js.id AND ja.disabled=FALSE AND ja.account_purpose='jellyfin'
        LEFT JOIN active_playback_sessions aps
               ON aps.server_id=js.id
        LEFT JOIN jellyfin_server_metrics m ON m.server_id=js.id
        WHERE js.server_class=$1
        GROUP BY js.id,pse.weight,pse.server_id,m.server_id,m.active_streams,m.managed_streams,m.observed_at,m.last_error
        ORDER BY js.priority,js.name
    `, [plan.server_class, plan.id]);
    const restricted = result.rows.some(server => server.selected);
    return { servers: result.rows, restricted };
}

function strategyOptions(selected) {
    const rows = [
        ['balanced', 'Balanced (recommended)', 'Health, customer-user capacity, live streams and priority'],
        ['lowest_customers', 'Lowest customer count', 'Prefer the eligible server with the fewest managed Jellyfin customers'],
        ['lowest_streams', 'Lowest live streams', 'Prefer the eligible server with the fewest current playback sessions'],
        ['weighted', 'Weighted distribution', 'Split new customers using server weights, excluding servers already at user capacity'],
        ['manual', 'Pinned server', 'Always use one selected server unless its configured customer-user capacity is full']
    ];
    return rows.map(([value, label, help]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${esc(label)} — ${esc(help)}</option>`).join('');
}

function serverRows(data) {
    return data.servers.map(server => {
        const checked = data.restricted && server.selected;
        const disabled = !server.enabled || !server.allow_new_users;
        const load = placement.fleetLoad(server);
        const full = placement.atCapacity(server);
        const max = server.max_users == null || Number(server.max_users) <= 0 ? 'No limit' : Number(server.max_users).toLocaleString('en-GB');
        const existingWeight = server.placement_weight == null ? 100 : Number(server.placement_weight);
        const capacity = full ? '<span class="pill bad">Full</span>' : '<span class="pill good">Available</span>';
        return `<tr>
            <td><input type="checkbox" name="serverIds" value="${esc(server.id)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}></td>
            <td><strong>${esc(server.name)}</strong><div class="muted">${esc(server.slug)}${server.location ? ` · ${esc(server.location)}` : ''}</div></td>
            <td><span class="pill ${healthClass(server.health_status)}">${esc(healthLabel(server.health_status))}</span><div class="subText">${capacity}</div></td>
            <td><strong>${load.users.toLocaleString('en-GB')}</strong> / ${esc(max)}<div class="subText">One managed customer = one place</div></td>
            <td><strong>${load.streams.toLocaleString('en-GB')}</strong><div class="subText">Playback load only — not capacity</div></td>
            <td><span class="pill good">Managed customers</span><div class="subText">CAPTAiNFiN account count</div></td>
            <td><input class="input" style="max-width:7rem" type="number" min="1" max="10000" name="weight_${esc(server.id)}" value="${esc(existingWeight)}" ${disabled ? 'disabled' : ''}></td>
        </tr>`;
    }).join('');
}

function page(req, plan, data) {
    const strategy = placement.normalizeStrategy(plan.placement_strategy);
    const poolMode = data.restricted ? 'selected' : 'all';
    const empty = !data.servers.length;
    const body = `${notice(req.query.message)}${notice(req.query.error, 'error')}${planSubnav(plan.id, 'placement',plan.service_type)}
        <section class="section">
            <div class="sectionHead"><div><h2>Server placement</h2><div class="settings-hint">Capacity is the number of managed Jellyfin customers on each server. Live streams may help balance placement, but never consume customer places.</div></div></div>
            <div class="notice">Existing customers are never moved automatically. One enabled managed Jellyfin customer uses exactly one server place, regardless of that customer's concurrent-stream allowance.</div>
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
                    <thead><tr><th>Use</th><th>Server</th><th>Health</th><th>Customers / capacity</th><th>Live streams</th><th>Capacity source</th><th>Weight</th></tr></thead>
                    <tbody>${serverRows(data)}</tbody>
                </table></div>
                <div class="inlineHelp">Configured server capacity is always customer based. Jellyfin administrators, service identities and unmanaged accounts do not consume CAPTAiNFiN customer places. Live playback is a balancing signal only.</div>`}
                <div class="buttonRow"><button class="button">Save placement</button></div>
            </form>
        </section><style>.fleetPlacementTable{min-width:1120px}</style>`;
    return layout({ siteName: site(), active: 'plans', title: `${plan.name} · Servers`, subtitle: `${plan.server_class} server pool`, body });
}

function createAdminPlanPlacementFleetRouter() {
    const router = express.Router();
    router.use('/admin/plans', gate, noStore);
    router.get('/admin/plans/:id/placement', async (req, res, next) => {
        try {
            const plan = await planById(req.params.id);
            if (!plan) return res.status(404).send('Plan not found');
            if(!jellyfinPlan(plan))return res.redirect(`/admin/plans/${encodeURIComponent(plan.id)}/edit?error=${encodeURIComponent('This is a Stremio-only plan. Jellyfin server placement does not apply.')}`);
            return res.send(page(req, plan, await placementData(plan)));
        } catch (error) { return next(error); }
    });
    return router;
}

module.exports = { createAdminPlanPlacementFleetRouter, placementData, page, jellyfinPlan };