'use strict';

const { getPool, query } = require('../db');
const registry = require('./registry');
const legacyActivity = require('./activity');

// The legacy observer owns the playback/history collector lock. This second
// lock serialises the full collect -> counter restore -> lane decision phase so
// multiple activity workers can never enforce the same lane concurrently.
const LANE_ADVISORY_LOCK_ID = 637441014;

function sessionKey(row) {
    return `${row.server_id}:${row.jellyfin_session_id}`;
}

function isCountable(row, cfg) {
    return cfg.countPaused || !row.is_paused;
}

function lane(value) {
    return String(value || '') === 'free' ? 'free' : 'primary';
}

function overflowRows(group, streamLimit, cfg = { countPaused: false }) {
    const countable = group.filter(row => isCountable(row, cfg));
    const limit = Math.max(1, Number(streamLimit) || 1);
    if (countable.length <= limit) return [];
    return [...countable]
        .sort((a, b) => new Date(b.first_seen_at || 0) - new Date(a.first_seen_at || 0))
        .slice(0, countable.length - limit);
}

async function laneEntitlements(customerIds) {
    const ids = [...new Set((customerIds || []).filter(Boolean).map(String))];
    if (!ids.length) return new Map();
    const result = await query(`
        SELECT s.customer_id,
               CASE WHEN p.is_free_tier THEN 'free' ELSE 'primary' END AS access_lane,
               COALESCE(
                 CASE WHEN (s.commercial_snapshot->>'streams') ~ '^[0-9]+$'
                      THEN (s.commercial_snapshot->>'streams')::int END,
                 p.streams
               ) AS streams,
               p.jellyfin_access_model,
               s.created_at,
               CASE WHEN o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id
                    THEN 'infinity'::timestamptz
                    ELSE s.current_period_end + ((COALESCE(s.service_extension_days,0)||' days')::interval)
               END AS access_expires_at
        FROM subscriptions s
        JOIN plans p ON p.id=s.plan_id
        JOIN customers c ON c.id=s.customer_id
        LEFT JOIN customer_entitlement_overrides o
               ON o.customer_id=s.customer_id AND o.subscription_id=s.id
        WHERE s.customer_id=ANY($1::uuid[])
          AND c.access_paused_at IS NULL
          AND COALESCE(p.is_addon,FALSE)=FALSE
          AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('jellyfin','bundle')
          AND s.superseded_by IS NULL
          AND s.starts_at<=NOW()
          AND (
              (o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id)
              OR (s.status IN ('active','trialing','past_due','paused') AND s.current_period_end>NOW())
              OR (COALESCE(s.service_extension_days,0)>0
                  AND s.status IN ('active','trialing','past_due','paused','cancelled','expired')
                  AND s.current_period_end+((s.service_extension_days||' days')::interval)>NOW())
          )
        ORDER BY s.customer_id,
                 CASE WHEN p.is_free_tier THEN 1 ELSE 0 END,
                 access_expires_at DESC,
                 s.created_at DESC
    `, [ids]);
    const map = new Map();
    for (const row of result.rows) {
        const key = `${row.customer_id}:${lane(row.access_lane)}`;
        if (!map.has(key)) map.set(key, row);
    }
    return map;
}

async function laneStreamOverrides(customerIds) {
    const ids = [...new Set((customerIds || []).filter(Boolean).map(String))];
    if (!ids.length) return new Map();
    const result = await query(`
        SELECT customer_id,access_lane,streams
        FROM customer_lane_policy_overrides
        WHERE customer_id=ANY($1::uuid[])
    `, [ids]);
    return new Map(result.rows.map(row => [`${row.customer_id}:${lane(row.access_lane)}`, row.streams]));
}

function effectiveStreamLimit(row, entitlements, overrideMap) {
    const accessLane = lane(row.access_lane);
    const entitlement = entitlements.get(`${row.customer_id}:${accessLane}`) || null;
    if (!entitlement) return null;
    const override = overrideMap.get(`${row.customer_id}:${accessLane}`);
    const raw = override === null || override === undefined ? entitlement.streams : override;
    const limit = Number(raw);
    return Number.isInteger(limit) && limit > 0 ? limit : 1;
}

async function observedSessionsWithLaneLimits() {
    const result = await query(`
        SELECT aps.server_id,aps.jellyfin_session_id,aps.playback_key,aps.customer_id,
               aps.jellyfin_account_id,aps.jellyfin_user_id,aps.device_name,aps.is_paused,
               aps.first_seen_at,aps.last_seen_at,aps.over_limit_confirmations,
               ja.access_lane,ja.disabled
        FROM active_playback_sessions aps
        JOIN jellyfin_accounts ja ON ja.id=aps.jellyfin_account_id
        WHERE ja.account_purpose='jellyfin'
    `);
    const customerIds = result.rows.map(row => row.customer_id);
    const [entitlements, overrideMap] = await Promise.all([
        laneEntitlements(customerIds),
        laneStreamOverrides(customerIds)
    ]);
    const rows = [];
    for (const row of result.rows) {
        if (row.disabled) continue;
        row.access_lane = lane(row.access_lane);
        row.streamLimit = effectiveStreamLimit(row, entitlements, overrideMap);
        await query(`
            UPDATE active_playback_sessions SET stream_limit=$3
            WHERE server_id=$1 AND jellyfin_session_id=$2
        `, [row.server_id, row.jellyfin_session_id, row.streamLimit]);
        rows.push(row);
    }
    return rows;
}

async function confirmationSnapshot() {
    const result = await query(`
        SELECT server_id,jellyfin_session_id,playback_key,over_limit_confirmations
        FROM active_playback_sessions
    `);
    return result.rows;
}

async function restoreLaneConfirmations(snapshot) {
    // The legacy observer still calculates its retired customer-wide policy in
    // observe mode. Restore counters around that collector so those decisions
    // can never influence the authoritative per-account confirmation state.
    await query('UPDATE active_playback_sessions SET over_limit_confirmations=0 WHERE over_limit_confirmations<>0');
    for (const row of snapshot || []) {
        const confirmations = Math.max(0, Number(row.over_limit_confirmations || 0));
        if (!confirmations) continue;
        await query(`
            UPDATE active_playback_sessions
            SET over_limit_confirmations=$4
            WHERE server_id=$1 AND jellyfin_session_id=$2 AND playback_key=$3
        `, [row.server_id,row.jellyfin_session_id,row.playback_key,confirmations]);
    }
}

async function removeLegacyDecisionEvents(startedAt) {
    await query(`
        DELETE FROM stream_policy_events
        WHERE created_at >= $1
          AND mode='observe'
          AND reason IN (
              'grace_period','confirmation_threshold','incomplete_server_snapshot',
              'enforcement_ack_missing','observe_only'
          )
    `, [startedAt]);
}

async function policyEvent(row, cfg, decision, streamCount, streamLimit, reason, detail = {}) {
    await query(`
        INSERT INTO stream_policy_events(
            customer_id,server_id,jellyfin_account_id,jellyfin_session_id,
            mode,decision,stream_count,stream_limit,reason,detail
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    `, [row.customer_id,row.server_id,row.jellyfin_account_id,row.jellyfin_session_id,
        cfg.effectiveMode,decision,streamCount,streamLimit,reason,JSON.stringify({ accessLane: row.access_lane, ...detail })]);
}

async function freshAccountSnapshot(row, cfg) {
    let sessions;
    try {
        sessions = await registry.request(row.server_id, `/Sessions?activeWithinSeconds=${encodeURIComponent(cfg.activeWindowSeconds)}`);
    } catch (error) {
        return { reliable: false, error: error.message, sessions: [] };
    }
    if (!Array.isArray(sessions)) return { reliable: false, error: 'Unexpected sessions response', sessions: [] };
    const userId = String(row.jellyfin_user_id || '').toLowerCase();
    return {
        reliable: true,
        sessions: sessions.filter(session =>
            session?.Id && session?.NowPlayingItem && String(session.UserId || '').toLowerCase() === userId
        ).map(session => ({
            sessionId: String(session.Id),
            isPaused: Boolean(session?.PlayState?.IsPaused),
            deviceId: session.DeviceId || null
        }))
    };
}

async function stopOverflowSession(row, streamCount, streamLimit, cfg) {
    const fresh = await freshAccountSnapshot(row, cfg);
    if (!fresh.reliable) {
        await policyEvent(row, cfg, 'skipped_safety', null, streamLimit, 'lane_revalidation_failed', { error: fresh.error });
        return false;
    }
    const countable = fresh.sessions.filter(session => cfg.countPaused || !session.isPaused);
    if (countable.length <= streamLimit) {
        await policyEvent(row, cfg, 'skipped_safety', countable.length, streamLimit, 'violation_cleared_before_action');
        return false;
    }
    if (!countable.some(session => session.sessionId === String(row.jellyfin_session_id))) {
        await policyEvent(row, cfg, 'skipped_safety', countable.length, streamLimit, 'candidate_changed_before_action');
        return false;
    }

    try {
        await registry.request(row.server_id, `/Sessions/${encodeURIComponent(row.jellyfin_session_id)}/Message`, {
            method: 'POST',
            timeoutMs: 5000,
            body: {
                Header: 'Concurrent stream limit reached',
                Text: `This ${row.access_lane === 'free' ? 'Free' : 'Premium'} Jellyfin access allows ${streamLimit} concurrent stream${streamLimit === 1 ? '' : 's'}. This extra playback will stop.`,
                TimeoutMs: 8000
            }
        });
    } catch (_) {}

    try {
        await registry.request(row.server_id, `/Sessions/${encodeURIComponent(row.jellyfin_session_id)}/Playing/Stop`, { method: 'POST' });
    } catch (error) {
        await policyEvent(row, cfg, 'stop_failed', countable.length, streamLimit, 'jellyfin_stop_failed', { error: error.message });
        return false;
    }

    await new Promise(resolve => setTimeout(resolve, 750));
    const verified = await freshAccountSnapshot(row, cfg);
    if (!verified.reliable) {
        await policyEvent(row, cfg, 'stop_failed', countable.length, streamLimit, 'post_stop_revalidation_failed', { error: verified.error });
        return false;
    }
    if (verified.sessions.some(session => session.sessionId === String(row.jellyfin_session_id))) {
        await policyEvent(row, cfg, 'stop_failed', countable.length, streamLimit, 'jellyfin_stop_did_not_end_session');
        return false;
    }

    await query(`UPDATE playback_history SET ended_at=NOW(),ended_reason='policy_stop',last_seen_at=NOW() WHERE server_id=$1 AND playback_key=$2`, [row.server_id,row.playback_key]);
    await query(`DELETE FROM active_playback_sessions WHERE server_id=$1 AND jellyfin_session_id=$2`, [row.server_id,row.jellyfin_session_id]);
    await policyEvent(row, cfg, 'stopped', streamCount, streamLimit, 'confirmed_lane_concurrent_stream_limit');
    return true;
}

async function evaluateLanePolicies(rows, failedServerIds, cfg) {
    const groups = new Map();
    for (const row of rows) {
        if (!row.streamLimit) continue;
        const key = String(row.jellyfin_account_id);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }
    const summary = { customers: new Set(rows.map(row => row.customer_id)).size, identities: groups.size, violations: 0, stopped: 0, skipped: 0 };

    for (const group of groups.values()) {
        const streamLimit = Number(group[0].streamLimit);
        const countable = group.filter(row => isCountable(row, cfg));
        if (countable.length <= streamLimit) {
            await query('UPDATE active_playback_sessions SET over_limit_confirmations=0 WHERE jellyfin_account_id=$1', [group[0].jellyfin_account_id]);
            continue;
        }
        summary.violations += 1;
        const overflow = overflowRows(group, streamLimit, cfg);
        const overflowKeys = new Set(overflow.map(sessionKey));
        for (const row of group) {
            if (!overflowKeys.has(sessionKey(row))) {
                await query('UPDATE active_playback_sessions SET over_limit_confirmations=0 WHERE server_id=$1 AND jellyfin_session_id=$2', [row.server_id,row.jellyfin_session_id]);
            }
        }
        for (const row of overflow) {
            const updated = await query(`UPDATE active_playback_sessions SET over_limit_confirmations=over_limit_confirmations+1 WHERE server_id=$1 AND jellyfin_session_id=$2 RETURNING over_limit_confirmations,first_seen_at`, [row.server_id,row.jellyfin_session_id]);
            if (!updated.rowCount) continue;
            const confirmations = Number(updated.rows[0].over_limit_confirmations || 0);
            const ageSeconds = (Date.now() - new Date(updated.rows[0].first_seen_at).getTime()) / 1000;
            if (ageSeconds < cfg.graceSeconds) {
                await policyEvent(row,cfg,'pending',countable.length,streamLimit,'grace_period',{ageSeconds:Math.floor(ageSeconds)});
                continue;
            }
            if (confirmations < cfg.confirmationsRequired) {
                await policyEvent(row,cfg,'pending',countable.length,streamLimit,'confirmation_threshold',{confirmations,required:cfg.confirmationsRequired});
                continue;
            }
            if (failedServerIds.has(String(row.server_id))) {
                summary.skipped += 1;
                await policyEvent(row,cfg,'skipped_safety',countable.length,streamLimit,'incomplete_lane_server_snapshot');
                continue;
            }
            if (cfg.effectiveMode !== 'enforce') {
                await policyEvent(row,cfg,'would_stop',countable.length,streamLimit,cfg.requestedMode === 'enforce' && !cfg.acknowledged ? 'enforcement_ack_missing' : 'observe_only');
                continue;
            }
            if (await stopOverflowSession(row,countable.length,streamLimit,cfg)) summary.stopped += 1;
            else summary.skipped += 1;
        }
    }
    return summary;
}

async function runActivityPolicyCycle() {
    const pool = getPool();
    const lockClient = await pool.connect();
    let locked = false;
    try {
        const lock = await lockClient.query('SELECT pg_try_advisory_lock($1) AS locked', [LANE_ADVISORY_LOCK_ID]);
        locked = Boolean(lock.rows[0]?.locked);
        if (!locked) return { skipped: true, reason: 'another_lane_monitor_is_running' };

        const cfg = legacyActivity.config();
        const startedAt = new Date();
        const before = await confirmationSnapshot();
        const previousMode = process.env.STREAM_POLICY_MODE;
        process.env.STREAM_POLICY_MODE = 'observe';
        let observed;
        try {
            observed = await legacyActivity.runActivityPolicyCycle();
        } finally {
            if (previousMode === undefined) delete process.env.STREAM_POLICY_MODE;
            else process.env.STREAM_POLICY_MODE = previousMode;
        }
        if (observed?.skipped) return observed;

        await restoreLaneConfirmations(before);
        await removeLegacyDecisionEvents(startedAt);

        const rows = await observedSessionsWithLaneLimits();
        const failedServerIds = new Set((observed.serverFailures || []).map(item => String(item.serverId)));
        const lanePolicy = await evaluateLanePolicies(rows, failedServerIds, cfg);
        return {
            ...observed,
            mode: cfg.effectiveMode,
            requestedMode: cfg.requestedMode,
            ...lanePolicy
        };
    } finally {
        if (locked) {
            try { await lockClient.query('SELECT pg_advisory_unlock($1)', [LANE_ADVISORY_LOCK_ID]); } catch (_) {}
        }
        lockClient.release();
    }
}

module.exports = {
    LANE_ADVISORY_LOCK_ID,
    runActivityPolicyCycle,
    evaluateLanePolicies,
    effectiveStreamLimit,
    observedSessionsWithLaneLimits,
    freshAccountSnapshot,
    overflowRows,
    laneEntitlements,
    laneStreamOverrides,
    restoreLaneConfirmations
};
