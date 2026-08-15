'use strict';

const core = require('./reseller-monthly-portal-core');
const monthly = require('../resellers/monthly');
const { query } = require('../db');

function pruneRoutes(router, paths) {
    if (!router?.stack) return router;
    router.stack = router.stack.filter(layer => {
        if (layer.route && paths.has(String(layer.route.path))) return false;
        if (layer.handle?.stack) pruneRoutes(layer.handle, paths);
        return true;
    });
    return router;
}

function createResellerMonthlyPortalRouter() {
    const router = core.createResellerMonthlyPortalRouter();
    // Dedicated canonical routers own tier changes and the append-only ledger.
    pruneRoutes(router, new Set(['/reseller/billing/tier','/reseller/sales']));
    return router;
}

// Compatibility API used by older integrations/smokes. Keep one analytics
// implementation: historical aggregation comes from the canonical reseller
// service and this facade only adapts the previous public shape.
async function analytics(resellerId, rng) {
    const start = new Date(rng?.start || Date.now() - 30 * 86400000);
    const end = new Date(rng?.end || Date.now());
    const days = Math.max(1, Math.min(45, Number(rng?.days) || Math.ceil((end - start) / 86400000) || 30));
    const [stats, live] = await Promise.all([
        monthly.salesAnalytics(resellerId, { from: start, to: end }),
        query(`SELECT COUNT(DISTINCT aps.jellyfin_session_id)::int streams
               FROM active_playback_sessions aps
               JOIN customers c ON c.id=aps.customer_id
               WHERE c.reseller_id=$1`, [resellerId])
    ]);
    const totals = Array.isArray(stats.totals) ? stats.totals : [];
    const primary = totals.slice().sort((a,b) => Number(b.amount_minor||0) - Number(a.amount_minor||0))[0]
        || { currency: 'GBP', amount_minor: 0, sales: 0 };
    const series = [];
    for (let i=days-1;i>=0;i--) {
        const d = new Date(end.getTime() - i*86400000);
        series.push({ key: d.toISOString().slice(0,10), value: 0 });
    }
    const byDay = new Map(series.map(point => [point.key, point]));
    for (const row of stats.daily || []) {
        if (String(row.currency || '').trim() !== String(primary.currency || '').trim()) continue;
        const parsed = new Date(row.sale_day);
        if (!Number.isFinite(parsed.getTime())) continue;
        const point = byDay.get(parsed.toISOString().slice(0,10));
        if (point) point.value += Number(row.amount_minor || 0);
    }
    return {
        totals,
        primary,
        newCustomers: Number(stats.newCustomers || 0),
        playback: stats.playback || {},
        liveStreams: Number(live.rows[0]?.streams || 0),
        top: stats.topCustomers || [],
        series
    };
}

module.exports = { ...core, createResellerMonthlyPortalRouter, pruneRoutes, analytics };