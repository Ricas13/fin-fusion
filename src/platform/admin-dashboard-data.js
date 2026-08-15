'use strict';

const { query } = require('../db');
const { setupReadiness } = require('./setup-readiness');
const { analyticsData } = require('./admin-dashboard-analytics');

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

async function dashboardData(range) {
    const [analytics, setup, options] = await Promise.all([
        analyticsData(range),
        setupReadiness(),
        dashboardOptions()
    ]);
    return { ...analytics, setup, options };
}

module.exports = { dashboardData, dashboardOptions };
