'use strict';

const { query } = require('../db');

function isNativeAdmin(req) {
    return Boolean(req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId);
}

async function dashboardData() {
    const [customers, subscriptions, playback, servers, policyEvents] = await Promise.all([
        query('SELECT COUNT(*)::int AS count FROM customers'),
        query("SELECT COUNT(*)::int AS count FROM subscriptions WHERE status IN ('active','trialing') AND (current_period_end IS NULL OR current_period_end > NOW())"),
        query("SELECT COUNT(*)::int AS streams, COUNT(*) FILTER (WHERE playback_method='transcode')::int AS transcodes FROM active_playback_sessions"),
        query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE health_status='healthy')::int AS healthy, COUNT(*) FILTER (WHERE health_status='offline')::int AS offline FROM jellyfin_servers WHERE enabled=TRUE"),
        query("SELECT decision,COUNT(*)::int AS count FROM stream_policy_events WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY decision")
    ]);

    const policy = Object.fromEntries(policyEvents.rows.map(row => [row.decision, Number(row.count)]));
    return {
        customers: Number(customers.rows[0]?.count || 0),
        activeSubscriptions: Number(subscriptions.rows[0]?.count || 0),
        activeStreams: Number(playback.rows[0]?.streams || 0),
        transcodes: Number(playback.rows[0]?.transcodes || 0),
        servers: Number(servers.rows[0]?.total || 0),
        healthyServers: Number(servers.rows[0]?.healthy || 0),
        offlineServers: Number(servers.rows[0]?.offline || 0),
        wouldStop24h: Number(policy.would_stop || 0),
        safetySkips24h: Number(policy.skipped_safety || 0)
    };
}

async function dashboardPage(req, res) {
    if (!isNativeAdmin(req)) return res.redirect('/login?session=expired');
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    try {
        return res.render('admin/dashboard', {
            siteName: process.env.SITE_NAME || 'CAPTaINFiN',
            stats: await dashboardData(),
            streamPolicyMode: String(process.env.STREAM_POLICY_MODE || 'observe').toLowerCase(),
            admin2faRequired: process.env.REQUIRE_ADMIN_2FA !== 'false'
        });
    } catch (error) {
        console.error('Admin dashboard failed:', error.message);
        return res.status(500).render('auth/message', {
            siteName: process.env.SITE_NAME || 'CAPTaINFiN',
            title: 'Dashboard unavailable',
            message: 'The administration dashboard could not be loaded safely.',
            link: '/admin/servers',
            linkText: 'Open Servers'
        });
    }
}

module.exports = { dashboardPage, dashboardData };
