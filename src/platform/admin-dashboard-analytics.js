'use strict';

const { query } = require('../db');

const PRESETS = new Map([
    ['today', { days: 1, label: 'Today' }],
    ['7d', { days: 7, label: 'Last 7 days' }],
    ['30d', { days: 30, label: 'Last 30 days' }],
    ['90d', { days: 90, label: 'Last 90 days' }],
    ['180d', { days: 180, label: 'Last 6 months' }],
    ['365d', { days: 365, label: 'Last 12 months' }]
]);

function startOfUtcDay(date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function parseIsoDate(value) {
    const text = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const parsed = new Date(`${text}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) return null;
    return parsed;
}

function rangeBucket(days) {
    if (days <= 45) return 'day';
    if (days <= 210) return 'week';
    return 'month';
}

function dashboardRange(input = {}, now = new Date()) {
    const preset = PRESETS.has(String(input.range || '')) ? String(input.range) : '30d';
    let start;
    let end;
    let label;
    let key = preset;

    if (String(input.range || '') === 'custom') {
        const from = parseIsoDate(input.from);
        const to = parseIsoDate(input.to);
        if (from && to && from <= to) {
            const inclusiveDays = Math.floor((to - from) / 86400000) + 1;
            if (inclusiveDays >= 1 && inclusiveDays <= 1095) {
                start = from;
                end = new Date(to.getTime() + 86400000);
                label = `${from.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })} – ${to.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`;
                key = 'custom';
            }
        }
    }

    if (!start) {
        const p = PRESETS.get(preset);
        end = new Date(now);
        if (preset === 'today') start = startOfUtcDay(now);
        else start = new Date(now.getTime() - p.days * 86400000);
        label = p.label;
    }

    const durationMs = Math.max(86400000, end.getTime() - start.getTime());
    const days = Math.max(1, Math.ceil(durationMs / 86400000));
    const previousEnd = new Date(start);
    const previousStart = new Date(start.getTime() - durationMs);
    return {
        key,
        start,
        end,
        previousStart,
        previousEnd,
        days,
        bucket: rangeBucket(days),
        label,
        from: start.toISOString().slice(0, 10),
        to: new Date(end.getTime() - 1).toISOString().slice(0, 10)
    };
}

function bucketStart(value, bucket) {
    const d = new Date(value);
    if (bucket === 'month') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    if (bucket === 'week') {
        const day = d.getUTCDay() || 7;
        return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 1));
    }
    return startOfUtcDay(d);
}

function bucketKey(value, bucket) {
    const d = bucketStart(value, bucket);
    if (bucket === 'month') return d.toISOString().slice(0, 7);
    return d.toISOString().slice(0, 10);
}

function advanceBucket(value, bucket) {
    const d = new Date(value);
    if (bucket === 'month') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    return new Date(d.getTime() + (bucket === 'week' ? 7 : 1) * 86400000);
}

function bucketLabel(value, bucket) {
    const d = bucketStart(value, bucket);
    if (bucket === 'month') return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function emptyBuckets(range) {
    const rows = [];
    let cursor = bucketStart(range.start, range.bucket);
    const end = bucketStart(range.end, range.bucket);
    let guard = 0;
    while (cursor < range.end && guard++ < 500) {
        rows.push({ key: bucketKey(cursor, range.bucket), label: bucketLabel(cursor, range.bucket) });
        cursor = advanceBucket(cursor, range.bucket);
        if (cursor > end && cursor >= range.end) break;
    }
    return rows;
}

function fillSeries(range, rows, valueFields) {
    const byKey = new Map(rows.map(row => [bucketKey(row.bucket || row.created_at || row.started_at, range.bucket), row]));
    return emptyBuckets(range).map(point => {
        const source = byKey.get(point.key) || {};
        const output = { ...point };
        for (const field of valueFields) output[field] = Number(source[field] || 0);
        return output;
    });
}

function decimalToMinor(value) {
    const text = String(value == null ? '' : value).trim();
    if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
    const negative = text.startsWith('-');
    const unsigned = negative ? text.slice(1) : text;
    const [whole, fraction = ''] = unsigned.split('.');
    const minor = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
    return negative ? -minor : minor;
}

function stripeObject(payload) {
    return payload?.data?.object || null;
}

function revenueFromEvent(row) {
    const payload = row.payload || {};
    if (row.provider === 'stripe') {
        const object = stripeObject(payload);
        if (!object) return null;
        if (row.event_type === 'invoice.paid') {
            const amount = Number(object.amount_paid);
            if (!Number.isFinite(amount) || amount < 0) return null;
            return {
                minor: amount,
                currency: String(object.currency || 'USD').toUpperCase(),
                email: object.customer_email || object.account_name || null
            };
        }
        if (row.event_type === 'checkout.session.completed' && object.mode === 'payment' && ['paid', 'no_payment_required'].includes(object.payment_status)) {
            const amount = Number(object.amount_total);
            if (!Number.isFinite(amount) || amount < 0) return null;
            return {
                minor: amount,
                currency: String(object.currency || 'USD').toUpperCase(),
                email: object.customer_details?.email || object.customer_email || null
            };
        }
        return null;
    }

    if (row.provider === 'paypal') {
        const resource = payload.resource || {};
        if (row.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
            const minor = decimalToMinor(resource.amount?.value);
            if (minor == null || minor < 0) return null;
            return {
                minor,
                currency: String(resource.amount?.currency_code || 'USD').toUpperCase(),
                email: resource.payee?.email_address || payload.resource?.payer?.email_address || null
            };
        }
        if (row.event_type === 'PAYMENT.SALE.COMPLETED') {
            const minor = decimalToMinor(resource.amount?.total);
            if (minor == null || minor < 0) return null;
            return {
                minor,
                currency: String(resource.amount?.currency || 'USD').toUpperCase(),
                email: resource.payer?.payer_info?.email || resource.payee?.email || null
            };
        }
    }
    return null;
}

function revenueSummary(events, range, fallbackCurrency = 'USD') {
    const current = [];
    const previous = [];
    const byCurrency = new Map();
    for (const row of events) {
        const payment = revenueFromEvent(row);
        if (!payment) continue;
        const at = new Date(row.created_at);
        const record = { ...payment, provider: row.provider, eventType: row.event_type, createdAt: at, providerEventId: row.provider_event_id };
        if (at >= range.start && at < range.end) current.push(record);
        else if (at >= range.previousStart && at < range.previousEnd) previous.push(record);
    }
    for (const record of current) byCurrency.set(record.currency, (byCurrency.get(record.currency) || 0) + record.minor);
    const primaryCurrency = [...byCurrency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || fallbackCurrency || 'USD';
    const totalMinor = current.filter(row => row.currency === primaryCurrency).reduce((sum, row) => sum + row.minor, 0);
    const previousMinor = previous.filter(row => row.currency === primaryCurrency).reduce((sum, row) => sum + row.minor, 0);
    const buckets = emptyBuckets(range).map(point => ({ ...point, revenue_minor: 0 }));
    const bucketMap = new Map(buckets.map(point => [point.key, point]));
    for (const record of current) {
        if (record.currency !== primaryCurrency) continue;
        const point = bucketMap.get(bucketKey(record.createdAt, range.bucket));
        if (point) point.revenue_minor += record.minor;
    }
    return {
        primaryCurrency,
        totalMinor,
        previousMinor,
        currencies: [...byCurrency.entries()].map(([currency, minor]) => ({ currency, minor })),
        series: buckets,
        recent: current.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 12)
    };
}

function delta(current, previous) {
    current = Number(current || 0);
    previous = Number(previous || 0);
    if (!previous) return current ? null : 0;
    return ((current - previous) / previous) * 100;
}

async function planFallbackCurrency() {
    const result = await query(`
        SELECT currency,COUNT(*)::int count
        FROM plans WHERE active=TRUE
        GROUP BY currency ORDER BY count DESC,currency LIMIT 1
    `);
    return String(result.rows[0]?.currency || 'USD').toUpperCase();
}

async function analyticsData(range) {
    const bucket = ['day', 'week', 'month'].includes(range.bucket) ? range.bucket : 'day';
    const forecastEnd = new Date(Date.now() + range.days * 86400000);
    const fallbackCurrencyPromise = planFallbackCurrency();

    const [
        currentTotals,
        periodTotals,
        previousTotals,
        paymentEvents,
        playbackTrendRows,
        customerGrowthRows,
        customerBaseline,
        planMix,
        playbackMethods,
        serverLoad,
        topStreamers,
        topDevices,
        topContent,
        topReferrers,
        renewals,
        operational
    ] = await Promise.all([
        query(`
            SELECT
                (SELECT COUNT(*)::int FROM customers) customers,
                (SELECT COUNT(*)::int FROM subscriptions WHERE status IN ('active','trialing') AND current_period_end>NOW()) active_subscriptions,
                (SELECT COUNT(*)::int FROM jellyfin_servers WHERE enabled=TRUE) servers,
                (SELECT COUNT(*)::int FROM jellyfin_servers WHERE enabled=TRUE AND health_status='healthy') healthy_servers,
                (SELECT COALESCE(SUM(active_streams),0)::int FROM jellyfin_server_metrics m JOIN jellyfin_servers s ON s.id=m.server_id WHERE s.enabled=TRUE) fleet_streams,
                (SELECT COALESCE(SUM(managed_streams),0)::int FROM jellyfin_server_metrics m JOIN jellyfin_servers s ON s.id=m.server_id WHERE s.enabled=TRUE) managed_streams,
                (SELECT COALESCE(SUM(total_users),0)::int FROM jellyfin_server_metrics m JOIN jellyfin_servers s ON s.id=m.server_id WHERE s.enabled=TRUE) jellyfin_users
        `),
        query(`
            SELECT
                (SELECT COUNT(*)::int FROM customers WHERE created_at >= $1 AND created_at < $2) new_customers,
                (SELECT COUNT(*)::int FROM subscriptions WHERE created_at >= $1 AND created_at < $2) new_subscriptions,
                (SELECT COUNT(*)::int FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.created_at >= $1 AND s.created_at < $2 AND p.billing_interval='trial') trial_starts,
                (SELECT COUNT(*)::int FROM playback_history WHERE started_at >= $1 AND started_at < $2) playback_sessions,
                (SELECT COUNT(DISTINCT customer_id)::int FROM playback_history WHERE customer_id IS NOT NULL AND started_at >= $1 AND started_at < $2) unique_viewers,
                (SELECT COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(ended_at,last_seen_at)-started_at)))),0)::bigint FROM playback_history WHERE started_at >= $1 AND started_at < $2) playback_seconds,
                (SELECT COUNT(*) FILTER(WHERE playback_method='transcode')::int FROM playback_history WHERE started_at >= $1 AND started_at < $2) transcode_sessions
        `, [range.start, range.end]),
        query(`
            SELECT
                (SELECT COUNT(*)::int FROM customers WHERE created_at >= $1 AND created_at < $2) new_customers,
                (SELECT COUNT(*)::int FROM subscriptions WHERE created_at >= $1 AND created_at < $2) new_subscriptions,
                (SELECT COUNT(*)::int FROM playback_history WHERE started_at >= $1 AND started_at < $2) playback_sessions,
                (SELECT COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(ended_at,last_seen_at)-started_at)))),0)::bigint FROM playback_history WHERE started_at >= $1 AND started_at < $2) playback_seconds
        `, [range.previousStart, range.previousEnd]),
        query(`
            SELECT provider,provider_event_id,event_type,payload,created_at
            FROM payment_events
            WHERE provider IN ('stripe','paypal')
              AND processed_at IS NOT NULL AND processing_error IS NULL
              AND created_at >= $1 AND created_at < $2
            ORDER BY created_at DESC
            LIMIT 25000
        `, [range.previousStart, range.end]),
        query(`
            SELECT date_trunc('${bucket}',started_at) bucket,
                   COUNT(*)::int sessions,
                   COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(ended_at,last_seen_at)-started_at)))),0)::bigint seconds
            FROM playback_history
            WHERE started_at >= $1 AND started_at < $2
            GROUP BY 1 ORDER BY 1
        `, [range.start, range.end]),
        query(`
            SELECT date_trunc('${bucket}',created_at) bucket,COUNT(*)::int added
            FROM customers WHERE created_at >= $1 AND created_at < $2
            GROUP BY 1 ORDER BY 1
        `, [range.start, range.end]),
        query('SELECT COUNT(*)::int count FROM customers WHERE created_at < $1', [range.start]),
        query(`
            SELECT p.name,p.code,COUNT(*)::int count
            FROM subscriptions s JOIN plans p ON p.id=s.plan_id
            WHERE s.status IN ('active','trialing') AND s.current_period_end>NOW()
            GROUP BY p.id ORDER BY count DESC,p.name
        `),
        query(`
            SELECT playback_method,COUNT(*)::int count
            FROM playback_history
            WHERE started_at >= $1 AND started_at < $2
            GROUP BY playback_method ORDER BY count DESC
        `, [range.start, range.end]),
        query(`
            SELECT s.id,s.name,s.server_class,s.health_status,s.max_users,
                   m.total_users,m.active_streams,m.managed_streams,m.transcode_streams,m.direct_stream_streams,m.direct_play_streams,m.observed_at,m.last_error
            FROM jellyfin_servers s
            LEFT JOIN jellyfin_server_metrics m ON m.server_id=s.id
            WHERE s.enabled=TRUE ORDER BY COALESCE(m.active_streams,0) DESC,s.priority,s.name
        `),
        query(`
            SELECT ph.customer_id,COALESCE(c.display_name,u.username,c.email,'Customer') name,
                   COUNT(*)::int sessions,
                   COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(ph.ended_at,ph.last_seen_at)-ph.started_at)))),0)::bigint seconds
            FROM playback_history ph
            LEFT JOIN customers c ON c.id=ph.customer_id
            LEFT JOIN app_users u ON u.id=c.user_id
            WHERE ph.started_at >= $1 AND ph.started_at < $2 AND ph.customer_id IS NOT NULL
            GROUP BY ph.customer_id,c.display_name,u.username,c.email
            ORDER BY seconds DESC,sessions DESC LIMIT 10
        `, [range.start, range.end]),
        query(`
            SELECT COALESCE(NULLIF(device_name,''),NULLIF(client_name,''),'Unknown device') name,COUNT(*)::int sessions,
                   COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(ended_at,last_seen_at)-started_at)))),0)::bigint seconds
            FROM playback_history
            WHERE started_at >= $1 AND started_at < $2
            GROUP BY 1 ORDER BY sessions DESC,seconds DESC LIMIT 10
        `, [range.start, range.end]),
        query(`
            SELECT COALESCE(NULLIF(item_name,''),'Unknown item') name,COALESCE(NULLIF(item_type,''),'Media') item_type,COUNT(*)::int sessions,
                   COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(ended_at,last_seen_at)-started_at)))),0)::bigint seconds
            FROM playback_history
            WHERE started_at >= $1 AND started_at < $2
            GROUP BY 1,2 ORDER BY sessions DESC,seconds DESC LIMIT 10
        `, [range.start, range.end]),
        query(`
            SELECT rc.customer_id,COALESCE(c.display_name,u.username,c.email,'Customer') name,COUNT(rr.id)::int referrals,
                   COUNT(*) FILTER(WHERE rr.status='rewarded')::int rewarded
            FROM referral_redemptions rr
            JOIN referral_codes rc ON rc.id=rr.referral_code_id
            JOIN customers c ON c.id=rc.customer_id
            LEFT JOIN app_users u ON u.id=c.user_id
            WHERE rr.created_at >= $1 AND rr.created_at < $2
            GROUP BY rc.customer_id,c.display_name,u.username,c.email
            ORDER BY referrals DESC,rewarded DESC LIMIT 10
        `, [range.start, range.end]),
        query(`
            SELECT s.id,s.customer_id,s.source,s.current_period_end,s.cancel_at_period_end,p.name plan_name,p.price_minor,p.currency,
                   COALESCE(c.display_name,u.username,c.email,'Customer') name
            FROM subscriptions s
            JOIN plans p ON p.id=s.plan_id
            JOIN customers c ON c.id=s.customer_id
            LEFT JOIN app_users u ON u.id=c.user_id
            WHERE s.status IN ('active','trialing') AND s.cancel_at_period_end=FALSE
              AND s.current_period_end > NOW() AND s.current_period_end <= $1
              AND s.billing_mode='subscription' AND s.source IN ('stripe','paypal')
            ORDER BY s.current_period_end LIMIT 1000
        `, [forecastEnd]),
        query(`
            SELECT
                (SELECT COUNT(*)::int FROM jellyfin_servers WHERE enabled=TRUE AND health_status='offline') offline_servers,
                (SELECT COUNT(*)::int FROM payment_events WHERE processing_error IS NOT NULL AND created_at>NOW()-INTERVAL '24 hours') payment_errors_24h,
                (SELECT COUNT(*)::int FROM customer_provisioning_state WHERE status IN ('blocked','failed')) provisioning_problems,
                (SELECT COUNT(*)::int FROM request_user_sync WHERE status='failed') request_sync_problems
        `)
    ]);

    const fallbackCurrency = await fallbackCurrencyPromise;
    const revenue = revenueSummary(paymentEvents.rows, range, fallbackCurrency);
    const period = periodTotals.rows[0] || {};
    const previous = previousTotals.rows[0] || {};
    const current = currentTotals.rows[0] || {};

    const playbackSeries = fillSeries(range, playbackTrendRows.rows, ['sessions', 'seconds']).map(row => ({
        ...row,
        hours: Number(row.seconds || 0) / 3600
    }));

    let runningCustomers = Number(customerBaseline.rows[0]?.count || 0);
    const growthAdditions = fillSeries(range, customerGrowthRows.rows, ['added']);
    const customerGrowth = growthAdditions.map(row => {
        runningCustomers += Number(row.added || 0);
        return { ...row, total: runningCustomers };
    });

    const renewalTotals = new Map();
    for (const row of renewals.rows) {
        const currency = String(row.currency || fallbackCurrency).toUpperCase();
        renewalTotals.set(currency, (renewalTotals.get(currency) || 0) + Number(row.price_minor || 0));
    }

    return {
        range,
        current: {
            customers: Number(current.customers || 0),
            activeSubscriptions: Number(current.active_subscriptions || 0),
            servers: Number(current.servers || 0),
            healthyServers: Number(current.healthy_servers || 0),
            fleetStreams: Number(current.fleet_streams || 0),
            managedStreams: Number(current.managed_streams || 0),
            jellyfinUsers: Number(current.jellyfin_users || 0)
        },
        period: {
            newCustomers: Number(period.new_customers || 0),
            newSubscriptions: Number(period.new_subscriptions || 0),
            trialStarts: Number(period.trial_starts || 0),
            playbackSessions: Number(period.playback_sessions || 0),
            uniqueViewers: Number(period.unique_viewers || 0),
            playbackSeconds: Number(period.playback_seconds || 0),
            transcodeSessions: Number(period.transcode_sessions || 0),
            revenueMinor: revenue.totalMinor,
            revenueCurrency: revenue.primaryCurrency,
            delta: {
                newCustomers: delta(period.new_customers, previous.new_customers),
                newSubscriptions: delta(period.new_subscriptions, previous.new_subscriptions),
                playbackSessions: delta(period.playback_sessions, previous.playback_sessions),
                playbackSeconds: delta(period.playback_seconds, previous.playback_seconds),
                revenue: delta(revenue.totalMinor, revenue.previousMinor)
            }
        },
        revenue,
        playbackSeries,
        customerGrowth,
        planMix: planMix.rows,
        playbackMethods: playbackMethods.rows,
        serverLoad: serverLoad.rows,
        topStreamers: topStreamers.rows,
        topDevices: topDevices.rows,
        topContent: topContent.rows,
        topReferrers: topReferrers.rows,
        renewals: renewals.rows.slice(0, 12),
        renewalCount: renewals.rows.length,
        renewalTotals: [...renewalTotals.entries()].map(([currency, minor]) => ({ currency, minor })),
        forecastDays: range.days,
        operational: operational.rows[0] || {}
    };
}

module.exports = {
    PRESETS,
    dashboardRange,
    analyticsData,
    revenueFromEvent,
    revenueSummary,
    bucketKey,
    fillSeries,
    delta
};