'use strict';

const { query } = require('../db');
const registry = require('./registry');
const legacyActivity = require('./activity');
const subscriptionState = require('../entitlements/subscription-state');
const laneOverrides = require('./lane-policy-overrides');

function sessionKey(row) {
    return `${row.server_id}:${row.jellyfin_session_id}`;
}

function isCountable(row, cfg) {
    return cfg.countPaused || !row.is_paused;
}

async function entitlementFor(customerId, accessLane, cache) {
    const key = `${customerId}:${accessLane}`;
    if (cache.has(key)) return cache.get(key);
    let entitlement;
    if (accessLane === 'free') {
        entitlement = await subscriptionState.liveFreeJellyfinSubscription(customerId, { includeBlocked: true });
    } else {
        entitlement = await subscriptionState.effectiveSubscription(customerId, { includeBlocked: true });
        if (entitlement?.is_free_tier) entitlement = null;
    }
    if (entitlement?.blocked) entitlement = null;
    cache.set(key, entitlement || null);
    return entitlement || null;
}

async function effectiveStreamLimit(row, cache) {
    const accessLane = row.access_lane === 'free' ? 'free' : 'primary';
    const entitlement = await entitlementFor(row.customer_id, accessLane, cache);
    if (!entitlement) return null;
    if (entitlement.jellyfin_access_model === 'household_network') return null;
    const override = await laneOverrides.getPolicyOverride(row.customer_id, accessLane);
    const raw = override?.streams ?? entitlement.streams;
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
    const cache = new Map();
    const rows = [];
    for (const row of result.rows) {
        if (row.disabled) continue;
        const streamLimit = await effectiveStreamLimit(row, cache);
        row.streamLimit = streamLimit;
        if (streamLimit !== null) {
            await query(`
                UPDATE active_playback_sessions SET stream_limit=$3
                WHERE server_id=$1 AND jellyfin_session_id=$2
            `, [row.server_id, row.jellyfin_session_id, streamLimit]);
        }
        rows.push(row);
    }
    return rows;
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
        const overflowCount = countable.length - streamLimit;
        const overflow = [...countable].sort((a,b) => new Date(b.first_seen_at) - new Date(a.first_seen_at)).slice(0, overflowCount);
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
    const cfg = legacyActivity.config();
    const startedAt = new Date();
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

    // The legacy observer is retained for telemetry/history collection only.
    // Remove decisions it made with the retired customer-wide grouping before
    // writing the authoritative account/lane decisions below.
    await query('DELETE FROM stream_policy_events WHERE created_at >= $1', [startedAt]);

    const rows = await observedSessionsWithLaneLimits();
    const failedServerIds = new Set((observed.serverFailures || []).map(item => String(item.serverId)));
    const lanePolicy = await evaluateLanePolicies(rows, failedServerIds, cfg);
    return {
        ...observed,
        mode: cfg.effectiveMode,
        requestedMode: cfg.requestedMode,
        ...lanePolicy
    };
}

module.exports = {
    runActivityPolicyCycle,
    evaluateLanePolicies,
    effectiveStreamLimit,
    observedSessionsWithLaneLimits,
    freshAccountSnapshot
};
