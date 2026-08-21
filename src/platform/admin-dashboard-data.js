'use strict';

const { query } = require('../db');
const { setupReadiness } = require('./setup-readiness');
const { analyticsData, dashboardRange } = require('./admin-dashboard-analytics');
const { normalizedDashboardMoney } = require('./admin-dashboard-money');
const subscriptionAnalytics = require('./subscription-analytics');
const attention = require('./attention');

function boundedInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

async function dashboardOptions() {
    const result = await query("SELECT setting_value FROM platform_settings WHERE setting_key='admin_defaults'");
    const value = result.rows[0]?.setting_value || {};
    return {
        expiringWindowDays: boundedInt(value.expiringWindowDays, 1, 30, 3),
        recentCustomerLimit: boundedInt(value.recentCustomerLimit, 5, 50, 12)
    };
}

async function legacyPolicyMetrics() {
    const result = await query(`
        SELECT
            COUNT(*) FILTER (WHERE decision='would_stop' AND created_at > NOW()-INTERVAL '24 hours')::int AS would_stop_24h,
            COUNT(*) FILTER (WHERE decision='skipped_safety' AND created_at > NOW()-INTERVAL '24 hours')::int AS safety_skips_24h
        FROM stream_policy_events
    `);
    return result.rows[0] || {};
}

function attentionSnapshot(items) {
    const sources = Array.isArray(items) ? items : [];
    let updatedAt = null;
    let latest = 0;
    for (const source of sources) {
        const ms = source.createdAt ? new Date(source.createdAt).getTime() : 0;
        if (Number.isFinite(ms) && ms > latest) {
            latest = ms;
            updatedAt = source.createdAt;
        }
    }
    return { count: sources.length, updatedAt, items: sources.slice(0, 5) };
}

async function dashboardData(range = null, reporting = null) {
    const selectedRange = range || dashboardRange({ range: '30d' });
    const [analytics, setup, options, policy, attentionItems, effectivePrimary] = await Promise.all([
        analyticsData(selectedRange),
        setupReadiness(),
        dashboardOptions(),
        legacyPolicyMetrics(),
        attention.list().catch(() => []),
        subscriptionAnalytics.effectivePrimarySummary(new Date())
    ]);
    analytics.current.activeCustomers = Number(effectivePrimary.activeCustomers || 0);
    analytics.primaryPlanMix = effectivePrimary.planMix || [];
    if (reporting) {
        const normalized = await normalizedDashboardMoney(selectedRange, analytics.revenue?.series || [], reporting);
        analytics.revenue = normalized.revenue;
        analytics.renewals = normalized.renewals;
        analytics.renewalCount = normalized.renewalCount;
        analytics.renewalTotals = normalized.renewalTotals;
        analytics.forecastDays = normalized.forecastDays;
        analytics.reportingCurrency = normalized.reportingCurrency;
        analytics.period.revenueMinor = normalized.revenue.totalMinor;
        analytics.period.revenueCurrency = normalized.reportingCurrency;
        analytics.period.delta.revenue = normalized.revenueDelta;
    }
    const transcodes = analytics.serverLoad.reduce((sum, row) => sum + Number(row.transcode_streams || 0), 0);
    const offlineServers = Number(analytics.operational?.offline_servers || 0);

    // Keep the original dashboardData() numeric surface for older internal
    // smoke tests and consumers while the new UI uses the richer structures.
    return {
        ...analytics,
        setup,
        attention: attentionSnapshot(attentionItems),
        options,
        customers: Number(analytics.current.customers || 0),
        activeSubscriptions: Number(analytics.current.activeSubscriptions || 0),
        activeStreams: Number(analytics.current.fleetStreams || 0),
        transcodes,
        servers: Number(analytics.current.servers || 0),
        healthyServers: Number(analytics.current.healthyServers || 0),
        offlineServers,
        wouldStop24h: Number(policy.would_stop_24h || 0),
        safetySkips24h: Number(policy.safety_skips_24h || 0)
    };
}

module.exports = { dashboardData, dashboardOptions, legacyPolicyMetrics, attentionSnapshot };
