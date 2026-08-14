'use strict';

const express = require('express');
const { query, transaction } = require('../db');
const csrf = require('../auth/csrf');
const placement = require('../jellyfin/placement');
const { esc, layout } = require('./admin-html');
const { planSubnav } = require('./admin-plans');

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
function list(value) { return Array.from(new Set((Array.isArray(value) ? value : [value]).map(v => String(v || '').trim()).filter(Boolean))); }
function weight(value) {
    const parsed = Number.parseInt(String(value || ''), 10);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10000 ? parsed : 100;
}
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

async function planById(id) {
    const result = await query('SELECT * FROM plans WHERE id=$1', [id]);
    return result.rows[0] || null;
}

async function placementData(plan) {
    const result = await query(`
        SELECT js.id,js.name,js.slug,js.server_class,js.location,js.enabled,js.allow_new_users,
               js.trial_enabled,js.paid_enabled,js.priority,js.max_users,js.health_status,
               COUNT(DISTINCT ja.id)::int AS assigned_users,
               COUNT(DISTINCT aps.jellyfin_session_id)::int AS active_streams,
               pse.weight AS placement_weight,
               (pse.server_id IS NOT NULL) AS selected
        FROM jellyfin_servers js
        LEFT JOIN plan_server_eligibility pse
               ON pse.plan_id=$2 AND pse.server_id=js.id
        LEFT JOIN jellyfin_accounts ja
               ON ja.server_id=js.id AND ja.disabled=FALSE
        LEFT JOIN active_playback_sessions aps
               ON aps.server_id=js.id
        WHERE js.server_class=$1
        GROUP BY js.id,pse.weight,pse.server_id
        ORDER BY js.priority,js.name
    `, [plan.server_class, plan.id]);
    const restricted = result.rows.some(server => server.selected);
    return { servers: result.rows, restricted };
}

function strategyOptions(selected) {
    const rows = [
        ['balanced', 'Balanced (recommended)', 'Health, capacity, streams, customers and priority'],
        ['lowest_customers', 'Lowest customer count', 'Place new accounts on the eligible server with the fewest managed customers'],
        ['lowest_streams', 'Lowest active streams', 'Prefer the eligible server with the fewest active streams'],
        ['weighted', 'Weighted distribution', 'Split new accounts using the server weights below'],
        ['manual', 'Pinned server', 'Always place new accounts on one selected server']
    ];
    return rows.map(([value, label, help]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${esc(label)} — ${esc(help)}</option>`).join('');
}

function serverRows(data) {
    return data.servers.map(server => {
        const checked = data.restricted && server.selected;
        const disabled = !server.enabled || !server.allow_new_users;
        const max = server.max_users == null ? 'No limit' : Number(server.max_users).toLocaleString('en-GB');
        const existingWeight = server.placement_weight == null ? 100 : Number(server.placement_weight);
        return `<tr>
            <td><input type="checkbox" name="serverIds" value="${esc(server.id)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}></td>
            <td><strong>${esc(server.name)}</strong><div class="muted">${esc(server.slug)}${server.location ? ` · ${esc(server.location)}` : ''}</div></td>
            <td><span class="pill ${healthClass(server.health_status)}">${esc(healthLabel(server.health_status))}</span></td>
            <td>${Number(server.assigned_users || 0).toLocaleString('en-GB')} / ${esc(max)}</td>
            <td>${Number(server.active_streams || 0).toLocaleString('en-GB')}</td>
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
            <div class="sectionHead"><div><h2>Server placement</h2><div class="settings-hint">Controls where newly provisioned Jellyfin accounts for this plan are created.</div></div></div>
            <div class="notice">Placement changes apply to <strong>new accounts</strong>. Existing customers are never moved automatically.</div>
            <form class="formPanel" method="post" action="/admin/plans/${esc(plan.id)}/placement">
                ${csrfInput(req)}
                <div class="formGroup">
                    <label>Placement strategy</label>
                    <select class="input" name="placementStrategy">${strategyOptions(strategy)}</select>
                </div>
                <div class="formGroup">
                    <label>Eligible server pool</label>
                    <label class="toggleRow"><input type="radio" name="poolMode" value="all" ${poolMode === 'all' ? 'checked' : ''}><span>All available <strong>${esc(plan.server_class)}</strong> servers</span></label>
                    <label class="toggleRow"><input type="radio" name="poolMode" value="selected" ${poolMode === 'selected' ? 'checked' : ''} ${empty ? 'disabled' : ''}><span>Only selected servers below</span></label>
                </div>
                ${empty ? `<div class="empty">No ${esc(plan.server_class)} Jellyfin servers are configured yet. This is valid — the plan can be saved now and servers can be added later. <a href="/admin/servers/new">Add a server</a>.</div>` : `
                <div class="tableWrap"><table class="dataTable">
                    <thead><tr><th>Use</th><th>Server</th><th>Health</th><th>Customers</th><th>Streams</th><th>Weight</th></tr></thead>
                    <tbody>${serverRows(data)}</tbody>
                </table></div>
                <div class="inlineHelp">Weights are used only by Weighted distribution. For example 50 / 30 / 20 produces a 50% / 30% / 20% split across three healthy eligible servers.</div>`}
                <div class="buttonRow"><button class="button">Save placement</button></div>
            </form>
        </section>`;
    return layout({
        siteName: site(),
        active: 'plans',
        title: `${plan.name} · Placement`,
        subtitle: `${plan.server_class} server pool`,
        body
    });
}

async function savePlacement(req, plan) {
    const strategy = placement.normalizeStrategy(req.body.placementStrategy);
    const poolMode = req.body.poolMode === 'selected' ? 'selected' : 'all';
    const requestedIds = list(req.body.serverIds);

    const available = await query(`
        SELECT id,name,enabled,allow_new_users FROM jellyfin_servers
        WHERE server_class=$1 ORDER BY priority,name
    `, [plan.server_class]);
    const byId = new Map(available.rows.map(server => [String(server.id), server]));
    const selected = requestedIds.map(id => byId.get(id)).filter(Boolean);

    if (poolMode === 'selected' && !selected.length) {
        throw new Error('Choose at least one eligible server or use all matching servers.');
    }
    if (selected.some(server => !server.enabled || !server.allow_new_users)) {
        throw new Error('Disabled servers or servers closed to new users cannot be selected.');
    }
    if (strategy === 'manual' && (poolMode !== 'selected' || selected.length !== 1)) {
        throw new Error('Pinned server placement requires exactly one selected server.');
    }

    const configured = selected.map(server => ({
        id: server.id,
        weight: weight(req.body[`weight_${server.id}`])
    }));

    await transaction(async client => {
        await client.query('UPDATE plans SET placement_strategy=$2,updated_at=NOW() WHERE id=$1', [plan.id, strategy]);
        await client.query('DELETE FROM plan_server_eligibility WHERE plan_id=$1', [plan.id]);
        if (poolMode === 'selected') {
            for (const server of configured) {
                await client.query(`
                    INSERT INTO plan_server_eligibility(plan_id,server_id,weight)
                    VALUES($1,$2,$3)
                `, [plan.id, server.id, server.weight]);
            }
        }
        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.plan.server_placement','plan',$2,$3::jsonb)
        `, [req.session.authUserId, plan.id, JSON.stringify({
            strategy,
            poolMode,
            servers: poolMode === 'selected' ? configured : []
        })]);
    });
}

function createAdminPlanPlacementRouter() {
    const router = express.Router();
    router.use('/admin/plans', gate, noStore);

    router.get('/admin/plans/:id/placement', async (req, res, next) => {
        try {
            const plan = await planById(req.params.id);
            if (!plan) return res.status(404).send('Plan not found');
            return res.send(page(req, plan, await placementData(plan)));
        } catch (error) { return next(error); }
    });

    router.post('/admin/plans/:id/placement', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const plan = await planById(req.params.id);
            if (!plan) return res.status(404).send('Plan not found');
            await savePlacement(req, plan);
            return res.redirect(`/admin/plans/${encodeURIComponent(plan.id)}/placement?message=${encodeURIComponent('Server placement saved.')}`);
        } catch (error) {
            console.warn('Plan placement update rejected:', error.message);
            return res.redirect(`/admin/plans/${encodeURIComponent(req.params.id)}/placement?error=${encodeURIComponent(error.message || 'Server placement could not be updated safely.')}`);
        }
    });

    return router;
}

module.exports = { createAdminPlanPlacementRouter, placementData, savePlacement };
