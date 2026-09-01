'use strict';

const express = require('express');
const { query, transaction } = require('../db');
const csrf = require('../auth/csrf');
const placement = require('../jellyfin/placement');
const serviceCatalog=require('../catalog/service-catalog');

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}
function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}
function list(value) { return Array.from(new Set((Array.isArray(value) ? value : [value]).map(v => String(v || '').trim()).filter(Boolean))); }
function weight(value) {
    const parsed = Number.parseInt(String(value || ''), 10);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10000 ? parsed : 100;
}
function mediaServerPlan(plan){return serviceCatalog.isMediaServerService(plan);}
function jellyfinPlan(plan){return mediaServerPlan(plan);}

async function planById(id) {
    const result = await query('SELECT * FROM plans WHERE id=$1', [id]);
    return result.rows[0] || null;
}

async function savePlacement(req, plan) {
    if(!mediaServerPlan(plan))throw new Error('Server placement does not apply to this plan type.');
    const strategy = placement.normalizeStrategy(req.body.placementStrategy);
    const poolMode = req.body.poolMode === 'selected' ? 'selected' : 'all';
    const requestedIds = list(req.body.serverIds);
    const mediaType=serviceCatalog.mediaServerType(plan);

    const available = await query(`
        SELECT id,name,enabled,allow_new_users,media_server_type FROM jellyfin_servers
        WHERE server_class=$1 AND COALESCE(media_server_type,'jellyfin')=$2 ORDER BY priority,name
    `, [plan.server_class,mediaType]);
    const byId = new Map(available.rows.map(server => [String(server.id), server]));
    const selected = requestedIds.map(id => byId.get(id)).filter(Boolean);

    if (poolMode === 'selected' && !selected.length) {
        throw new Error(`Choose at least one eligible ${serviceCatalog.label(plan)} server or use all matching servers.`);
    }
    if (selected.some(server => !server.enabled || !server.allow_new_users)) {
        throw new Error('Disabled servers or servers closed to new users cannot be selected.');
    }
    if (strategy === 'manual' && (poolMode !== 'selected' || selected.length !== 1)) {
        throw new Error('Pinned server placement requires exactly one selected server.');
    }

    const configured = selected.map(server => ({ id: server.id, weight: weight(req.body[`weight_${server.id}`]) }));
    await transaction(async client => {
        await client.query('UPDATE plans SET placement_strategy=$2,updated_at=NOW() WHERE id=$1', [plan.id, strategy]);
        await client.query('DELETE FROM plan_server_eligibility WHERE plan_id=$1', [plan.id]);
        if (poolMode === 'selected') {
            for (const server of configured) {
                await client.query('INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,$3)', [plan.id, server.id, server.weight]);
            }
        }
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.plan.server_placement','plan',$2,$3::jsonb)`, [req.session.authUserId, plan.id, JSON.stringify({ strategy, poolMode, mediaServerType:mediaType, servers: poolMode === 'selected' ? configured : [] })]);
    });
}

function createAdminPlanPlacementRouter() {
    const router = express.Router();
    router.use('/admin/plans', gate, noStore);
    router.post('/admin/plans/:id/placement', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
        try {
            const plan = await planById(req.params.id);
            if (!plan) return res.status(404).send('Plan not found');
            if(!mediaServerPlan(plan))return res.redirect(`/admin/plans/${encodeURIComponent(plan.id)}/edit?error=${encodeURIComponent('Server placement does not apply to this plan type.')}`);
            await savePlacement(req, plan);
            return res.redirect(`/admin/plans/${encodeURIComponent(plan.id)}/edit?message=${encodeURIComponent('Server placement saved.')}#delivery`);
        } catch (error) {
            console.warn('Plan placement update rejected:', error.message);
            return res.redirect(`/admin/plans/${encodeURIComponent(req.params.id)}/edit?error=${encodeURIComponent(error.message || 'Server placement could not be updated safely.')}#delivery`);
        }
    });
    return router;
}

module.exports = { createAdminPlanPlacementRouter, savePlacement, mediaServerPlan, jellyfinPlan };
