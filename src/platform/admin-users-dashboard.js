'use strict';

const express = require('express');
const { query } = require('../db');
const { layout, esc } = require('./admin-html');
const runtimeSettings = require('./runtime-settings');
const { dashboardRange, fillSeries } = require('./admin-dashboard-analytics');
const registry = require('./admin-dashboard-registry');
const widgets = require('./admin-dashboard-widgets');
const { renderWidgetGrid } = require('./admin-dashboard-page');
const attention = require('./attention');
const { rangeControls } = require('./admin-dashboard-view');
const { number } = require('./admin-dashboard-format');
const ui = require('./admin-ui');

function gate(req, res, next) {
    return req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId ? next() : res.redirect('/login?session=expired');
}
function noStore(_req, res, next) { res.setHeader('Cache-Control', 'no-store, private, max-age=0'); res.setHeader('Pragma', 'no-cache'); next(); }

async function activeUsersOverTime(range) {
    const bucket = ['day', 'week', 'month'].includes(range.bucket) ? range.bucket : 'day';
    const result = await query(`
        WITH buckets AS (
            SELECT generate_series(date_trunc($3,$1::timestamptz),date_trunc($3,$2::timestamptz),('1 '||$3)::interval) bucket
        )
        SELECT b.bucket,COUNT(DISTINCT s.customer_id)::int n
        FROM buckets b
        LEFT JOIN subscriptions s ON s.status IN('active','trialing','past_due','paused') AND s.starts_at<=b.bucket AND s.current_period_end>b.bucket
        GROUP BY 1 ORDER BY 1
    `, [range.start, range.end, bucket]);
    return fillSeries(range, result.rows, ['n']);
}

async function lifecycleActivity(range) {
    const bucket = ['day', 'week', 'month'].includes(range.bucket) ? range.bucket : 'day';
    const [created, cancelled, expired, renewed] = await Promise.all([
        query(`SELECT date_trunc('${bucket}',created_at) bucket,COUNT(*)::int n FROM subscriptions WHERE created_at>=$1 AND created_at<$2 GROUP BY 1`, [range.start, range.end]),
        query(`SELECT date_trunc('${bucket}',updated_at) bucket,COUNT(*)::int n FROM subscriptions WHERE status='cancelled' AND updated_at>=$1 AND updated_at<$2 GROUP BY 1`, [range.start, range.end]),
        query(`SELECT date_trunc('${bucket}',updated_at) bucket,COUNT(*)::int n FROM subscriptions WHERE status='expired' AND updated_at>=$1 AND updated_at<$2 GROUP BY 1`, [range.start, range.end]),
        query(`SELECT date_trunc('${bucket}',updated_at) bucket,COUNT(*)::int n FROM subscriptions WHERE status='active' AND updated_at>created_at AND updated_at>=$1 AND updated_at<$2 GROUP BY 1`, [range.start, range.end])
    ]);
    const c = fillSeries(range, created.rows, ['n']);
    const x = fillSeries(range, cancelled.rows, ['n']);
    const e = fillSeries(range, expired.rows, ['n']);
    const r = fillSeries(range, renewed.rows, ['n']);
    return c.map((row, i) => ({ label: row.label, key: row.key, newCount: row.n, cancelledCount: x[i]?.n || 0, expiredCount: e[i]?.n || 0, renewedCount: r[i]?.n || 0 }));
}

async function usersByService() {
    const result = await query(`
        SELECT COALESCE(s.service_type_snapshot,p.service_type) name,COUNT(DISTINCT s.customer_id)::int count
        FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        WHERE s.status IN('active','trialing') AND s.current_period_end>NOW()
        GROUP BY 1 ORDER BY 2 DESC
    `);
    return result.rows;
}

async function expiryDistribution() {
    const result = await query(`
        SELECT date_trunc('week',current_period_end) bucket,COUNT(*)::int n
        FROM subscriptions WHERE status IN('active','trialing') AND current_period_end>NOW() AND current_period_end<=NOW()+INTERVAL '90 days'
        GROUP BY 1 ORDER BY 1
    `);
    return result.rows.map(row => ({ label: new Date(row.bucket).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }), count: row.n }));
}

async function lifecycleFunnel() {
    const result = await query(`
        SELECT
            (SELECT COUNT(*)::int FROM customers) signed_up,
            (SELECT COUNT(DISTINCT customer_id)::int FROM subscriptions) activated,
            (SELECT COUNT(DISTINCT customer_id)::int FROM subscriptions WHERE status IN('active','trialing') AND current_period_end>NOW()) active_now
    `);
    const row = result.rows[0] || {};
    return [
        { label: 'Signed up', count: Number(row.signed_up || 0), href: '/admin/users' },
        { label: 'Activated a subscription', count: Number(row.activated || 0), href: '/admin/users?filter=subscribed' },
        { label: 'Active now', count: Number(row.active_now || 0), href: '/admin/users?filter=active' }
    ];
}

async function streamLimitUtilization() {
    const result = await query(`
        SELECT c.id customer_id,COALESCE(c.display_name,u.username,c.email,'Customer') name,COUNT(ph.id)::int live_streams,p.streams stream_limit
        FROM customers c
        JOIN subscriptions s ON s.customer_id=c.id AND s.status IN('active','trialing') AND s.current_period_end>NOW()
        JOIN plans p ON p.id=s.plan_id
        LEFT JOIN app_users u ON u.id=c.user_id
        LEFT JOIN playback_history ph ON ph.customer_id=c.id AND ph.ended_at IS NULL
        GROUP BY c.id,c.display_name,u.username,c.email,p.streams
        HAVING COUNT(ph.id)>0
        ORDER BY (COUNT(ph.id)::numeric/GREATEST(p.streams,1)) DESC,COUNT(ph.id) DESC
        LIMIT 20
    `);
    return result.rows;
}

async function usageDistribution(range) {
    const result = await query(`
        SELECT CASE WHEN n=0 THEN 'Inactive' WHEN n=1 THEN '1 session' WHEN n=2 THEN '2 sessions' ELSE '3+ sessions' END name,COUNT(*)::int count
        FROM (SELECT c.id,COUNT(ph.id)::int n FROM customers c LEFT JOIN playback_history ph ON ph.customer_id=c.id AND ph.started_at>=$1 AND ph.started_at<$2 GROUP BY c.id) t
        GROUP BY 1
    `, [range.start, range.end]);
    const order = ['Inactive', '1 session', '2 sessions', '3+ sessions'];
    return result.rows.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
}

async function customersRequiringAttention() {
    const items = await attention.list();
    return items.filter(item => item.area === 'Customers').slice(0, 15);
}

async function buildContext(req) {
    const range = dashboardRange(req.query || {});
    const [activeUsers, lifecycle, byService, expiry, funnel, utilization, usage, needsAttention, planMixRows] = await Promise.all([
        activeUsersOverTime(range), lifecycleActivity(range), usersByService(), expiryDistribution(), lifecycleFunnel(), streamLimitUtilization(), usageDistribution(range), customersRequiringAttention(),
        query(`SELECT p.name,COUNT(*)::int count FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.status IN('active','trialing') AND s.current_period_end>NOW() GROUP BY p.id ORDER BY count DESC,p.name`)
    ]);
    return { range, data: { activeUsers, lifecycle, byService, expiry, funnel, utilization, usage, needsAttention, planMix: planMixRows.rows } };
}
registry.registerContextBuilder('users', buildContext);

registry.register('users', 'activeUsersOverTime', { title: 'Active users over time', defaultOrder: 1, defaultSpan: 8, render: async ctx => widgets.areaChart(ctx.data.activeUsers, 'n') });
registry.register('users', 'lifecycleActivity', { title: 'Customer lifecycle activity', subtitle: '"Renewed" is approximate: any active subscription touched since it was created counts, since no explicit renewal event is logged.', defaultOrder: 2, defaultSpan: 8, render: async ctx => widgets.stackedAreaChart(ctx.data.lifecycle, ['newCount', 'renewedCount', 'expiredCount', 'cancelledCount']) });
registry.register('users', 'lifecycleFunnel', { title: 'Customer lifecycle funnel', subtitle: 'Only stages CAPTAiNFiN can compute reliably are shown.', defaultOrder: 3, defaultSpan: 4, render: async ctx => widgets.funnelChart(ctx.data.funnel) });
registry.register('users', 'usersByPlan', { title: 'Users by plan', defaultOrder: 4, defaultSpan: 6, render: async ctx => widgets.barChart(ctx.data.planMix.map(row => ({ label: row.name, count: row.count })), 'count', undefined, { orientation: 'horizontal' }) });
registry.register('users', 'usersByService', { title: 'Users by service', defaultOrder: 5, defaultSpan: 6, render: async ctx => widgets.donutChart(ctx.data.byService) });
registry.register('users', 'expiryDistribution', { title: 'Subscription expiry distribution', subtitle: 'Active/trialing subscriptions expiring in the next 90 days.', defaultOrder: 6, defaultSpan: 6, render: async ctx => widgets.barChart(ctx.data.expiry, 'count') });
registry.register('users', 'usageDistribution', { title: 'Usage distribution', subtitle: 'Playback sessions per customer in the selected period.', defaultOrder: 7, defaultSpan: 6, render: async ctx => widgets.donutChart(ctx.data.usage) });
registry.register('users', 'streamLimitUtilization', {
    title: 'Stream-limit utilization', subtitle: 'Customers currently streaming, against their plan’s concurrent-stream limit.', defaultOrder: 8, defaultSpan: 6, lazy: true,
    render: async ctx => {
        if (!ctx.data.utilization.length) return widgets.emptyState('No customer is currently at or near their stream limit.');
        return widgets.statusTable(ctx.data.utilization, [
            { key: 'name', label: 'Customer', render: row => `<a href="/admin/users/${esc(row.customer_id)}">${esc(row.name)}</a>` },
            { key: 'usage', label: 'Live / limit', align: 'numeric', render: row => `<strong class="${row.live_streams >= row.stream_limit ? 'statusBad' : ''}">${esc(row.live_streams)} / ${esc(row.stream_limit)}</strong>` }
        ]);
    }
});
registry.register('users', 'customersRequiringAttention', {
    title: 'Customers requiring attention', defaultOrder: 9, defaultSpan: 6, lazy: true,
    render: async ctx => {
        if (!ctx.data.needsAttention.length) return widgets.emptyState('No customers currently need attention.');
        return widgets.statusTable(ctx.data.needsAttention, [
            { key: 'title', label: 'Issue', render: row => `<a href="${esc(row.href)}">${esc(row.title)}</a>` },
            { key: 'severity', label: 'Severity', render: row => `<span class="pill ${row.severity === 'critical' ? 'bad' : 'warn'}">${esc(row.severity)}</span>` },
            { key: 'detail', label: 'Detail', render: row => esc(row.detail) }
        ]);
    }
});

function customerHero(ctx) {
    const funnel = Object.fromEntries((ctx.data.funnel || []).map(row => [row.label, Number(row.count || 0)]));
    const issues = ctx.data.needsAttention || [];
    const critical = issues.filter(item => item.severity === 'critical').length;
    const active = funnel['Active now'] || 0;
    const signedUp = funnel['Signed up'] || 0;
    const activated = funnel['Activated a subscription'] || 0;
    const tone = critical ? 'bad' : issues.length ? 'warn' : 'streaming';
    const title = critical ? `${critical} customer ${critical === 1 ? 'issue needs' : 'issues need'} urgent action` : issues.length ? `${issues.length} customer ${issues.length === 1 ? 'issue needs' : 'issues need'} review` : 'Customer access is clear';
    const next = issues[0] ? `Fix “${issues[0].title}” before reviewing customer analytics.` : signedUp && !activated ? 'Review customers who have signed up but not activated access.' : 'No customer intervention is required; use the analytics below for trends.';
    const primary = issues[0] ? `<a class="button" href="${esc(issues[0].href)}">Fix first customer issue</a>` : '<a class="button secondary" href="/admin/users">Open customer list</a>';
    return ui.operatorHero({
        tone,
        eyebrow: 'Customer control room',
        title,
        body: issues.length ? 'Customer-impacting exceptions are shown before charts so access problems do not get buried in reporting.' : 'No canonical customer exception is currently open.',
        statusLabel: critical ? 'Action required' : issues.length ? 'Review needed' : 'Customers clear',
        next,
        facts: [
            { label: 'Active now', value: number(active), detail: 'customers with current effective subscriptions' },
            { label: 'Signed up', value: number(signedUp), detail: 'all customer accounts' },
            { label: 'Activated', value: number(activated), detail: 'ever activated a subscription' },
            { label: 'Open issues', value: number(issues.length), detail: critical ? `${critical} critical` : 'from canonical Needs Attention' }
        ],
        actionsHtml: `${primary}<a class="button secondary" href="/admin/attention">View all Needs Attention</a>`
    });
}

async function renderPage(req) {
    const ctx = await buildContext(req);
    const widgetGrid = await renderWidgetGrid('users', req, ctx);
    const body_html = `${customerHero(ctx)}${rangeControls(ctx.range,'/admin/users/dashboard')}${widgetGrid}`;
    return layout({ siteName: runtimeSettings.siteName(), active: 'users-dashboard', title: 'Users dashboard', subtitle: `Customer health first, then lifecycle and usage analytics · ${ctx.range.label}`, body: body_html, action: '<a class="button secondary" href="/admin/users">Customer list</a>', pageClass: 'page-users-dashboard' });
}

function createAdminUsersDashboardRouter() {
    const router = express.Router();
    router.use('/admin/users/dashboard', gate, noStore);
    router.get('/admin/users/dashboard', async (req, res, next) => {
        try { return res.send(await renderPage(req)); } catch (error) { next(error); }
    });
    return router;
}

module.exports = { createAdminUsersDashboardRouter, buildContext, customerHero };
