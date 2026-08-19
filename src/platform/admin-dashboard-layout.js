'use strict';

const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { query, transaction } = require('../db');
const csrf = require('../auth/csrf');
const routeRateLimit = require('../security/route-rate-limit');
const registry = require('./admin-dashboard-registry');
const { SPAN_VALUES } = require('./admin-dashboard-widgets');

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.status(401).json({ ok: false, error: 'unauthorized' });
}
function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}
function layoutKey(req) { return req.session?.authUserId ? `admin:${req.session.authUserId}` : `ip:${ipKeyGenerator(req.ip)}`; }
const burstLimit = rateLimit({ windowMs: 60_000, limit: 60, keyGenerator: layoutKey, standardHeaders: false, legacyHeaders: false });
const persistentLimit = routeRateLimit.middleware({ scope: 'admin-dashboard-layout', max: 60, windowSeconds: 60 });

async function getLayout(adminUserId, dashboardKey) {
    const result = await query(
        `SELECT widget_key,position,span,visible,config FROM admin_dashboard_widget_layout WHERE admin_user_id=$1 AND dashboard_key=$2 ORDER BY position`,
        [adminUserId, dashboardKey]
    );
    return result.rows;
}

// Merges the admin's saved rows against the registry: registry-only widgets are
// appended (visible, at their default position); saved rows for widgets no longer
// registered are silently dropped, so the registry can evolve without corrupting
// an admin's old saved layout.
function mergeWithDefaults(dashboardKey, savedRows) {
    const widgets = registry.listWidgets(dashboardKey);
    const byKey = new Map(widgets.map(widget => [widget.key, widget]));
    const saved = savedRows.filter(row => byKey.has(row.widget_key));
    const savedKeys = new Set(saved.map(row => row.widget_key));
    const appended = widgets
        .filter(widget => !savedKeys.has(widget.key))
        .map(widget => ({ widget_key: widget.key, position: widget.defaultOrder, span: widget.defaultSpan, visible: true, config: {} }));
    const merged = [...saved, ...appended].sort((a, b) => a.position - b.position);
    return merged.map(row => ({
        ...row,
        title: byKey.get(row.widget_key).title,
        subtitle: byKey.get(row.widget_key).subtitle,
        defaultSpan: byKey.get(row.widget_key).defaultSpan,
        allowedTimeframes: byKey.get(row.widget_key).allowedTimeframes
    }));
}

function validateItems(dashboardKey, items) {
    if (!Array.isArray(items) || !items.length) throw new Error('At least one widget is required.');
    const positions = new Set();
    for (const item of items) {
        if (!registry.getWidget(dashboardKey, item.widgetKey)) throw new Error(`Unknown widget: ${item.widgetKey}`);
        if (!SPAN_VALUES.includes(Number(item.span))) throw new Error(`Invalid span for ${item.widgetKey}`);
        const position = Number(item.position);
        if (!Number.isInteger(position) || positions.has(position)) throw new Error('Widget positions must be unique integers.');
        positions.add(position);
    }
}

async function saveLayout(adminUserId, dashboardKey, items) {
    if (!registry.DASHBOARD_KEYS.includes(dashboardKey)) throw new Error('Unknown dashboard.');
    validateItems(dashboardKey, items);
    await transaction(async client => {
        await client.query(`DELETE FROM admin_dashboard_widget_layout WHERE admin_user_id=$1 AND dashboard_key=$2`, [adminUserId, dashboardKey]);
        for (const item of items) {
            await client.query(
                `INSERT INTO admin_dashboard_widget_layout(admin_user_id,dashboard_key,widget_key,position,span,visible,config) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
                [adminUserId, dashboardKey, item.widgetKey, Number(item.position), Number(item.span), item.visible !== false, JSON.stringify(item.config || {})]
            );
        }
        await client.query(
            `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.dashboard.layout.update','admin_dashboard_widget_layout',$2,$3::jsonb)`,
            [adminUserId, String(adminUserId), JSON.stringify({ dashboardKey, widgetCount: items.length })]
        );
    });
}

async function resetLayout(adminUserId, dashboardKey) {
    if (!registry.DASHBOARD_KEYS.includes(dashboardKey)) throw new Error('Unknown dashboard.');
    await transaction(async client => {
        await client.query(`DELETE FROM admin_dashboard_widget_layout WHERE admin_user_id=$1 AND dashboard_key=$2`, [adminUserId, dashboardKey]);
        await client.query(
            `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.dashboard.layout.reset','admin_dashboard_widget_layout',$2,$3::jsonb)`,
            [adminUserId, String(adminUserId), JSON.stringify({ dashboardKey })]
        );
    });
}

function dashboardKeyGate(req, res, next) {
    if (!registry.DASHBOARD_KEYS.includes(req.params.dashboardKey)) return res.status(404).json({ ok: false, error: 'unknown_dashboard' });
    return next();
}

function createAdminDashboardLayoutRouter() {
    const router = express.Router();
    router.use('/admin/api/dashboard/:dashboardKey', burstLimit, persistentLimit, gate, noStore, dashboardKeyGate);

    router.get('/admin/api/dashboard/:dashboardKey/layout', async (req, res) => {
        try {
            const saved = await getLayout(req.session.authUserId, req.params.dashboardKey);
            return res.json({ ok: true, widgets: mergeWithDefaults(req.params.dashboardKey, saved) });
        } catch (error) {
            console.error('dashboard layout load failed:', error.message);
            return res.status(500).json({ ok: false, error: 'load_failed' });
        }
    });

    router.put('/admin/api/dashboard/:dashboardKey/layout', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).json({ ok: false, error: 'invalid_csrf' });
        try {
            const items = (req.body?.widgets || []).map(w => ({ widgetKey: w.widgetKey, position: w.position, span: w.span, visible: w.visible, config: w.config }));
            await saveLayout(req.session.authUserId, req.params.dashboardKey, items);
            const saved = await getLayout(req.session.authUserId, req.params.dashboardKey);
            return res.json({ ok: true, widgets: mergeWithDefaults(req.params.dashboardKey, saved) });
        } catch (error) {
            return res.status(400).json({ ok: false, error: error.message || 'save_failed' });
        }
    });

    router.post('/admin/api/dashboard/:dashboardKey/layout/reset', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).json({ ok: false, error: 'invalid_csrf' });
        try {
            await resetLayout(req.session.authUserId, req.params.dashboardKey);
            return res.json({ ok: true, widgets: mergeWithDefaults(req.params.dashboardKey, []) });
        } catch (error) {
            return res.status(400).json({ ok: false, error: error.message || 'reset_failed' });
        }
    });

    router.get('/admin/api/dashboard/:dashboardKey/widget/:widgetKey', async (req, res) => {
        try {
            const widget = registry.getWidget(req.params.dashboardKey, req.params.widgetKey);
            if (!widget) return res.status(404).json({ ok: false, error: 'unknown_widget' });
            const buildContext = registry.getContextBuilder(req.params.dashboardKey);
            if (!buildContext) return res.status(503).json({ ok: false, error: 'not_ready' });
            const ctx = await buildContext(req);
            const html = await widget.render(ctx);
            return res.json({ ok: true, html });
        } catch (error) {
            console.error('lazy widget render failed:', error.message);
            return res.status(500).json({ ok: false, error: 'render_failed' });
        }
    });

    return router;
}

module.exports = { createAdminDashboardLayoutRouter, getLayout, mergeWithDefaults, saveLayout, resetLayout };
