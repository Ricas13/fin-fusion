'use strict';

const express = require('express');
const { query } = require('../db');
const activity = require('../jellyfin/activity');

function requireAdminSession(req, res, next) {
    if (req.session?.adminId && req.session?.userType === 'admin') return next();
    return res.redirect('/login');
}

async function dashboardData(cfg) {
    const [summaryResult, streamsResult, serversResult, eventsResult, historyResult] = await Promise.all([
        query(`
            SELECT
              (SELECT COUNT(*)::int FROM active_playback_sessions) AS active_streams,
              (SELECT COUNT(*)::int FROM active_playback_sessions WHERE playback_method='transcode') AS transcodes,
              (SELECT COUNT(*)::int FROM stream_policy_events WHERE created_at >= NOW()-INTERVAL '24 hours' AND decision IN ('would_stop','stopped')) AS violations_24h,
              (SELECT COUNT(*)::int FROM stream_policy_events WHERE created_at >= NOW()-INTERVAL '24 hours' AND decision='skipped_safety') AS safety_skips_24h,
              (SELECT COUNT(*)::int FROM jellyfin_servers WHERE enabled=TRUE) AS enabled_servers,
              (SELECT COUNT(*)::int FROM jellyfin_servers WHERE enabled=TRUE AND health_status='offline') AS offline_servers,
              (SELECT COUNT(*)::int FROM subscriptions WHERE status IN ('active','trialing','past_due') AND current_period_end>NOW()) AS active_subscriptions
        `),
        query(`
            SELECT aps.server_id,aps.jellyfin_session_id,aps.customer_id,aps.item_name,aps.item_type,
                   aps.client_name,aps.device_name,aps.playback_method,aps.is_paused,aps.first_seen_at,
                   aps.last_seen_at,aps.stream_limit,js.name AS server_name,ja.jellyfin_username,
                   COALESCE(NULLIF(c.display_name,''),au.username,ja.jellyfin_username,'Customer') AS customer_name
            FROM active_playback_sessions aps
            JOIN jellyfin_servers js ON js.id=aps.server_id
            LEFT JOIN jellyfin_accounts ja ON ja.id=aps.jellyfin_account_id
            LEFT JOIN customers c ON c.id=aps.customer_id
            LEFT JOIN app_users au ON au.id=c.user_id
            ORDER BY aps.first_seen_at ASC
            LIMIT 250
        `),
        query(`
            SELECT js.id,js.name,js.server_class,js.enabled,js.max_users,js.health_status,js.last_health_check,
                   COUNT(DISTINCT ja.id)::int AS assigned_users,
                   COUNT(DISTINCT aps.jellyfin_session_id)::int AS active_streams
            FROM jellyfin_servers js
            LEFT JOIN jellyfin_accounts ja ON ja.server_id=js.id AND ja.disabled=FALSE
            LEFT JOIN active_playback_sessions aps ON aps.server_id=js.id
            GROUP BY js.id
            ORDER BY js.priority,js.name
        `),
        query(`
            SELECT spe.decision,spe.mode,spe.stream_count,spe.stream_limit,spe.reason,spe.created_at,
                   js.name AS server_name,
                   COALESCE(NULLIF(c.display_name,''),au.username,ja.jellyfin_username,'Customer') AS customer_name
            FROM stream_policy_events spe
            LEFT JOIN jellyfin_servers js ON js.id=spe.server_id
            LEFT JOIN jellyfin_accounts ja ON ja.id=spe.jellyfin_account_id
            LEFT JOIN customers c ON c.id=spe.customer_id
            LEFT JOIN app_users au ON au.id=c.user_id
            ORDER BY spe.created_at DESC
            LIMIT 60
        `),
        query(`
            SELECT ph.item_name,ph.item_type,ph.client_name,ph.device_name,ph.playback_method,
                   ph.started_at,ph.ended_at,ph.ended_reason,js.name AS server_name,
                   COALESCE(NULLIF(c.display_name,''),au.username,ja.jellyfin_username,'Customer') AS customer_name
            FROM playback_history ph
            JOIN jellyfin_servers js ON js.id=ph.server_id
            LEFT JOIN jellyfin_accounts ja ON ja.id=ph.jellyfin_account_id
            LEFT JOIN customers c ON c.id=ph.customer_id
            LEFT JOIN app_users au ON au.id=c.user_id
            ORDER BY ph.started_at DESC
            LIMIT 60
        `)
    ]);

    const streams = streamsResult.rows;
    const counts = new Map();
    for (const stream of streams) {
        if (!stream.customer_id) continue;
        if (!cfg.countPaused && stream.is_paused) continue;
        counts.set(stream.customer_id, (counts.get(stream.customer_id) || 0) + 1);
    }
    for (const stream of streams) stream.customer_stream_count = counts.get(stream.customer_id) || 0;

    return {
        summary: summaryResult.rows[0],
        streams,
        servers: serversResult.rows,
        events: eventsResult.rows,
        history: historyResult.rows
    };
}

function createAdminActivityRouter() {
    const router = express.Router();
    router.use('/admin/activity', requireAdminSession, (_req, res, next) => {
        res.setHeader('Cache-Control', 'no-store, private');
        res.setHeader('Pragma', 'no-cache');
        next();
    });

    router.get('/admin/activity', requireAdminSession, async (req, res, next) => {
        try {
            const cfg = activity.config();
            const data = await dashboardData(cfg);
            await query(`
                INSERT INTO audit_log(action,entity_type,entity_id,metadata)
                VALUES('admin.activity.view','admin_dashboard','activity',$1::jsonb)
            `, [JSON.stringify({ legacyAdminId: req.session.adminId })]);
            return res.render('admin/activity', {
                siteName: process.env.SITE_NAME || 'CAPTAiNFiN',
                cfg,
                ...data
            });
        } catch (error) {
            return next(error);
        }
    });

    return router;
}

module.exports = { createAdminActivityRouter, requireAdminSession, dashboardData };
