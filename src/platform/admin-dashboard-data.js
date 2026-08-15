'use strict';

const { query } = require('../db');
const { setupReadiness } = require('./setup-readiness');
const { analyticsData, dashboardRange } = require('./admin-dashboard-analytics');

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

async function dashboardData(range = null) {
    const selectedRange = range || dashboardRange({ range: '30d' });
    const [analytics, setup, options, policy] = await Promise.all([
        analyticsData(selectedRange),
        setupReadiness(),
        dashboardOptions(),
        legacyPolicyMetrics()
    ]);
    const transcodes = analytics.serverLoad.reduce((sum, row) => sum + Number(row.transcode_streams || 0), 0);
    const offlineServers = Number(analytics.operational?.offline_servers || 0);

    // Keep the original dashboardData() numeric surface for older internal
    // smoke tests and consumers while the new UI uses the richer structures.
    return {
        ...analytics,
        setup,
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

module.exports = { dashboardData, dashboardOptions, legacyPolicyMetrics };
