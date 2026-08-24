'use strict';

const crypto = require('crypto');
const { getPool, query } = require('../db');
const { encryptString } = require('../crypto');
const registry = require('./registry');

const ENFORCEMENT_ACK = 'I_UNDERSTAND_THIS_STOPS_PLAYBACK';
const ADVISORY_LOCK_ID = 637441013;

function intEnv(name, fallback, min, max) {
    const value = Number.parseInt(process.env[name] || '', 10);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
}

function config() {
    const requestedMode = String(process.env.STREAM_POLICY_MODE || 'observe').toLowerCase() === 'enforce'
        ? 'enforce'
        : 'observe';
    const acknowledged = process.env.STREAM_POLICY_ENFORCEMENT_ACK === ENFORCEMENT_ACK;
    return {
        requestedMode,
        effectiveMode: requestedMode === 'enforce' && acknowledged ? 'enforce' : 'observe',
        acknowledged,
        activeWindowSeconds: intEnv('STREAM_POLICY_ACTIVE_WINDOW_SECONDS', 120, 30, 600),
        graceSeconds: intEnv('STREAM_POLICY_GRACE_SECONDS', 45, 10, 900),
        confirmationsRequired: intEnv('STREAM_POLICY_CONFIRMATIONS', 2, 2, 10),
        countPaused: process.env.STREAM_POLICY_COUNT_PAUSED === 'true',
        historyRetentionDays: intEnv('ACTIVITY_RETENTION_DAYS', 90, 7, 3650),
        eventRetentionDays: intEnv('POLICY_EVENT_RETENTION_DAYS', 365, 30, 3650)
    };
}

function playbackMethod(session) {
    const method = String(session?.PlayState?.PlayMethod || '').toLowerCase();
    if (method === 'directplay') return 'directplay';
    if (method === 'directstream') return 'directstream';
    if (method === 'transcode' || session?.TranscodingInfo) return 'transcode';
    return 'unknown';
}

function playbackKey(serverId, session) {
    const playSessionId = session?.PlayState?.PlaySessionId || '';
    const itemId = session?.NowPlayingItem?.Id || '';
    return crypto
        .createHash('sha256')
        .update(`${serverId}|${session.Id}|${playSessionId}|${itemId}`)
        .digest('hex');
}

function effectiveStreamLimit(entitlement) {
    if (!entitlement) return null;
    if (entitlement.jellyfin_access_model === 'household_network') return null;
    const streams = Number(entitlement.streams);
    return Number.isInteger(streams) && streams > 0 ? streams : 1;
}

function normalizeSession(serverId, account, entitlement, session) {
    const state = session.PlayState || {};
    const transcodeReasons = Array.isArray(session?.TranscodingInfo?.TranscodeReasons)
        ? session.TranscodingInfo.TranscodeReasons
        : [];
    return {
        serverId,
        sessionId: String(session.Id),
        playbackKey: playbackKey(serverId, session),
        customerId: account.customer_id,
        accountId: account.id,
        jellyfinUserId: account.jellyfin_user_id,
        playSessionId: state.PlaySessionId || null,
        itemId: session?.NowPlayingItem?.Id || null,
        itemName: session?.NowPlayingItem?.Name || null,
        itemType: session?.NowPlayingItem?.Type || null,
        clientName: session.Client || null,
        deviceName: session.DeviceName || null,
        applicationVersion: session.ApplicationVersion || null,
        remoteEndpointEncrypted: session.RemoteEndPoint ? encryptString(session.RemoteEndPoint) : null,
        method: playbackMethod(session),
        transcodeReasons,
        isPaused: Boolean(state.IsPaused),
        positionTicks: Number.isFinite(Number(state.PositionTicks)) ? Number(state.PositionTicks) : null,
        lastActivityAt: session.LastActivityDate ? new Date(session.LastActivityDate) : null,
        streamLimit: effectiveStreamLimit(entitlement),
        supportsMediaControl: session.SupportsMediaControl === true,
        raw: session
    };
}

async function activeEntitlements() {
    const result = await query(`
        SELECT DISTINCT ON (s.customer_id)
            s.customer_id,s.id AS subscription_id,p.id AS plan_id,p.code,p.streams,p.jellyfin_access_model,
            s.current_period_end + (COALESCE(s.service_extension_days,0)||' days')::interval AS access_expires_at
        FROM subscriptions s
        JOIN plans p ON p.id=s.plan_id
        JOIN customers c ON c.id=s.customer_id
        WHERE s.superseded_by IS NULL
          AND s.starts_at<=NOW()
          AND c.access_paused_at IS NULL
          AND (
              (s.status IN ('active','trialing','past_due','paused') AND s.current_period_end>NOW())
              OR (COALESCE(s.service_extension_days,0)>0
                  AND s.status IN ('active','trialing','past_due','paused','cancelled','expired')
                  AND s.current_period_end+(s.service_extension_days||' days')::interval>NOW())
          )
        ORDER BY s.customer_id,
                 (s.current_period_end+(COALESCE(s.service_extension_days,0)||' days')::interval) DESC,
                 s.created_at DESC
    `);
    return new Map(result.rows.map(row => [row.customer_id, row]));
}

async function managedAccountsByServer() {
    const result = await query(`
        SELECT ja.id,ja.customer_id,ja.server_id,ja.jellyfin_user_id,ja.disabled,
               js.name AS server_name,js.enabled,js.health_status
        FROM jellyfin_accounts ja
        JOIN jellyfin_servers js ON js.id=ja.server_id
        WHERE js.enabled=TRUE
          AND COALESCE(ja.account_purpose,'jellyfin')<>'stremio_internal'
    `);
    const byServer = new Map();
    for (const row of result.rows) {
        if (!byServer.has(row.server_id)) byServer.set(row.server_id, []);
        byServer.get(row.server_id).push(row);
    }
    return byServer;
}

async function upsertObservedSession(s) {
    const prior = await query(`
        SELECT playback_key,first_seen_at
        FROM active_playback_sessions
        WHERE server_id=$1 AND jellyfin_session_id=$2
    `, [s.serverId, s.sessionId]);

    if (prior.rowCount && prior.rows[0].playback_key !== s.playbackKey) {
        await query(`
            UPDATE playback_history
            SET ended_at=COALESCE(ended_at,NOW()),ended_reason=COALESCE(ended_reason,'item_changed'),last_seen_at=NOW()
            WHERE server_id=$1 AND playback_key=$2
        `, [s.serverId, prior.rows[0].playback_key]);
    }

    const resetFirstSeen = !prior.rowCount || prior.rows[0].playback_key !== s.playbackKey;
    const active = await query(`
        INSERT INTO active_playback_sessions(
            server_id,jellyfin_session_id,playback_key,customer_id,jellyfin_account_id,jellyfin_user_id,
            play_session_id,item_id,item_name,item_type,client_name,device_name,application_version,
            remote_endpoint_encrypted,playback_method,transcode_reasons,is_paused,position_ticks,
            last_activity_at,stream_limit,first_seen_at,last_seen_at,over_limit_confirmations
        ) VALUES(
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,NOW(),NOW(),0
        )
        ON CONFLICT(server_id,jellyfin_session_id) DO UPDATE SET
            playback_key=EXCLUDED.playback_key,
            customer_id=EXCLUDED.customer_id,
            jellyfin_account_id=EXCLUDED.jellyfin_account_id,
            jellyfin_user_id=EXCLUDED.jellyfin_user_id,
            play_session_id=EXCLUDED.play_session_id,
            item_id=EXCLUDED.item_id,
            item_name=EXCLUDED.item_name,
            item_type=EXCLUDED.item_type,
            client_name=EXCLUDED.client_name,
            device_name=EXCLUDED.device_name,
            application_version=EXCLUDED.application_version,
            remote_endpoint_encrypted=COALESCE(active_playback_sessions.remote_endpoint_encrypted,EXCLUDED.remote_endpoint_encrypted),
            playback_method=EXCLUDED.playback_method,
            transcode_reasons=EXCLUDED.transcode_reasons,
            is_paused=EXCLUDED.is_paused,
            position_ticks=EXCLUDED.position_ticks,
            last_activity_at=EXCLUDED.last_activity_at,
            stream_limit=EXCLUDED.stream_limit,
            first_seen_at=CASE WHEN active_playback_sessions.playback_key <> EXCLUDED.playback_key THEN NOW() ELSE active_playback_sessions.first_seen_at END,
            last_seen_at=NOW(),
            over_limit_confirmations=CASE WHEN active_playback_sessions.playback_key <> EXCLUDED.playback_key THEN 0 ELSE active_playback_sessions.over_limit_confirmations END
        RETURNING first_seen_at,over_limit_confirmations
    `, [
        s.serverId,s.sessionId,s.playbackKey,s.customerId,s.accountId,s.jellyfinUserId,
        s.playSessionId,s.itemId,s.itemName,s.itemType,s.clientName,s.deviceName,s.applicationVersion,
        s.remoteEndpointEncrypted,s.method,JSON.stringify(s.transcodeReasons),s.isPaused,s.positionTicks,
        s.lastActivityAt,s.streamLimit
    ]);

    await query(`
        INSERT INTO playback_history(
            server_id,customer_id,jellyfin_account_id,playback_key,jellyfin_session_id,item_id,item_name,item_type,
            client_name,device_name,playback_method,transcode_reasons,started_at,last_seen_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,NOW(),NOW())
        ON CONFLICT(server_id,playback_key) DO UPDATE SET
            last_seen_at=NOW(),
            playback_method=EXCLUDED.playback_method,
            transcode_reasons=EXCLUDED.transcode_reasons,
            ended_at=NULL,
            ended_reason=NULL
    `, [
        s.serverId,s.customerId,s.accountId,s.playbackKey,s.sessionId,s.itemId,s.itemName,s.itemType,
        s.clientName,s.deviceName,s.method,JSON.stringify(s.transcodeReasons)
    ]);

    s.firstSeenAt = resetFirstSeen ? new Date() : new Date(active.rows[0].first_seen_at);
    s.confirmations = Number(active.rows[0].over_limit_confirmations || 0);
    return s;
}

async function closeMissingSessions(serverId, seenSessionIds) {
    const existing = await query(`
        SELECT jellyfin_session_id,playback_key
        FROM active_playback_sessions WHERE server_id=$1
    `, [serverId]);
    for (const row of existing.rows) {
        if (seenSessionIds.has(row.jellyfin_session_id)) continue;
        await query(`
            UPDATE playback_history
            SET ended_at=COALESCE(ended_at,NOW()),ended_reason=COALESCE(ended_reason,'not_seen'),last_seen_at=NOW()
            WHERE server_id=$1 AND playback_key=$2
        `, [serverId, row.playback_key]);
        await query(`
            DELETE FROM active_playback_sessions
            WHERE server_id=$1 AND jellyfin_session_id=$2
        `, [serverId, row.jellyfin_session_id]);
    }
}

async function pollServer(serverId, accounts, entitlements, cfg) {
    const endpoint = `/Sessions?activeWithinSeconds=${encodeURIComponent(cfg.activeWindowSeconds)}`;
    const sessions = await registry.request(serverId, endpoint);
    if (!Array.isArray(sessions)) throw new Error('Jellyfin sessions response was not an array');

    const accountByUser = new Map(accounts.map(a => [String(a.jellyfin_user_id).toLowerCase(), a]));
    const seen = new Set();
    const managed = [];

    for (const session of sessions) {
        if (!session?.Id || !session?.UserId || !session?.NowPlayingItem) continue;
        const account = accountByUser.get(String(session.UserId).toLowerCase());
        if (!account) continue;
        const entitlement = entitlements.get(account.customer_id) || null;
        const normalized = normalizeSession(serverId, account, entitlement, session);
        seen.add(normalized.sessionId);
        managed.push(await upsertObservedSession(normalized));
    }

    await closeMissingSessions(serverId, seen);
    return managed;
}

async function policyEvent({ session, mode, decision, streamCount, streamLimit, reason, detail = {} }) {
    await query(`
        INSERT INTO stream_policy_events(
            customer_id,server_id,jellyfin_account_id,jellyfin_session_id,mode,decision,stream_count,stream_limit,reason,detail
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    `, [
        session?.customerId || null, session?.serverId || null, session?.accountId || null, session?.sessionId || null,
        mode, decision, streamCount ?? null, streamLimit ?? null, reason, JSON.stringify(detail)
    ]);
}

async function freshCustomerSnapshot(customerId, cfg) {
    const accountsResult = await query(`
        SELECT ja.id,ja.customer_id,ja.server_id,ja.jellyfin_user_id
        FROM jellyfin_accounts ja
        JOIN jellyfin_servers js ON js.id=ja.server_id
        WHERE ja.customer_id=$1
          AND js.enabled=TRUE
          AND COALESCE(ja.account_purpose,'jellyfin')<>'stremio_internal'
    `, [customerId]);
    const byServer = new Map();
    for (const account of accountsResult.rows) {
        if (!byServer.has(account.server_id)) byServer.set(account.server_id, []);
        byServer.get(account.server_id).push(account);
    }

    const current = [];
    for (const [serverId, accounts] of byServer) {
        const accountByUser = new Map(accounts.map(a => [String(a.jellyfin_user_id).toLowerCase(), a]));
        let sessions;
        try {
            sessions = await registry.request(serverId, `/Sessions?activeWithinSeconds=${encodeURIComponent(cfg.activeWindowSeconds)}`);
        } catch (error) {
            return { reliable: false, error: error.message, sessions: [] };
        }
        if (!Array.isArray(sessions)) return { reliable: false, error: 'Unexpected sessions response', sessions: [] };
        for (const session of sessions) {
            if (!session?.Id || !session?.UserId || !session?.NowPlayingItem) continue;
            const account = accountByUser.get(String(session.UserId).toLowerCase());
            if (!account) continue;
            current.push({
                serverId,
                accountId: account.id,
                customerId,
                sessionId: String(session.Id),
                playbackKey: playbackKey(serverId, session),
                isPaused: Boolean(session?.PlayState?.IsPaused),
                supportsMediaControl: session.SupportsMediaControl === true
            });
        }
    }
    return { reliable: true, sessions: current };
}

async function stopSessionSafely(candidate, streamLimit, cfg) {
    const fresh = await freshCustomerSnapshot(candidate.customerId, cfg);
    if (!fresh.reliable) {
        await policyEvent({
            session: candidate, mode: cfg.effectiveMode, decision: 'skipped_safety',
            streamCount: null, streamLimit, reason: 'revalidation_failed', detail: { error: fresh.error }
        });
        return false;
    }

    const countable = fresh.sessions.filter(s => cfg.countPaused || !s.isPaused);
    if (countable.length <= streamLimit) {
        await policyEvent({
            session: candidate, mode: cfg.effectiveMode, decision: 'skipped_safety',
            streamCount: countable.length, streamLimit, reason: 'violation_cleared_before_action'
        });
        return false;
    }

    const stillPresent = countable.find(s =>
        s.serverId === candidate.serverId &&
        s.sessionId === candidate.sessionId &&
        s.playbackKey === candidate.playbackKey
    );
    if (!stillPresent) {
        await policyEvent({
            session: candidate, mode: cfg.effectiveMode, decision: 'skipped_safety',
            streamCount: countable.length, streamLimit, reason: 'candidate_changed_before_action'
        });
        return false;
    }
    if (!stillPresent.supportsMediaControl) {
        await policyEvent({
            session: candidate, mode: cfg.effectiveMode, decision: 'skipped_safety',
            streamCount: countable.length, streamLimit, reason: 'client_does_not_report_media_control_support'
        });
        return false;
    }

    try {
        await registry.request(
            candidate.serverId,
            `/Sessions/${encodeURIComponent(candidate.sessionId)}/Playing/Stop`,
            { method: 'POST' }
        );
        await query(`
            UPDATE playback_history
            SET ended_at=NOW(),ended_reason='policy_stop',last_seen_at=NOW()
            WHERE server_id=$1 AND playback_key=$2
        `, [candidate.serverId, candidate.playbackKey]);
        await query(`
            DELETE FROM active_playback_sessions
            WHERE server_id=$1 AND jellyfin_session_id=$2
        `, [candidate.serverId, candidate.sessionId]);
        await policyEvent({
            session: candidate, mode: cfg.effectiveMode, decision: 'stopped',
            streamCount: countable.length, streamLimit, reason: 'confirmed_concurrent_stream_limit'
        });
        return true;
    } catch (error) {
        await policyEvent({
            session: candidate, mode: cfg.effectiveMode, decision: 'stop_failed',
            streamCount: countable.length, streamLimit, reason: 'jellyfin_stop_failed', detail: { error: error.message }
        });
        return false;
    }
}

async function evaluatePolicies(sessions, pollsReliable, cfg) {
    const groups = new Map();
    for (const session of sessions) {
        if (!session.customerId || !Number.isInteger(Number(session.streamLimit)) || Number(session.streamLimit) < 1) continue;
        if (!groups.has(session.customerId)) groups.set(session.customerId, []);
        groups.get(session.customerId).push(session);
    }

    const summary = { customers: groups.size, violations: 0, stopped: 0, skipped: 0 };
    for (const group of groups.values()) {
        const countable = group.filter(s => cfg.countPaused || !s.isPaused);
        const streamLimit = Math.min(...group.map(s => Number(s.streamLimit)).filter(Number.isFinite));
        if (countable.length <= streamLimit) {
            await query(`UPDATE active_playback_sessions SET over_limit_confirmations=0 WHERE customer_id=$1`, [group[0].customerId]);
            continue;
        }

        summary.violations += 1;
        const newestFirst = [...countable].sort((a, b) => new Date(b.firstSeenAt) - new Date(a.firstSeenAt));
        const overflowCount = countable.length - streamLimit;
        const overflow = newestFirst.slice(0, overflowCount);
        const overflowKeys = new Set(overflow.map(s => `${s.serverId}:${s.sessionId}`));

        for (const s of group) {
            if (!overflowKeys.has(`${s.serverId}:${s.sessionId}`)) {
                await query(`
                    UPDATE active_playback_sessions SET over_limit_confirmations=0
                    WHERE server_id=$1 AND jellyfin_session_id=$2
                `, [s.serverId, s.sessionId]);
            }
        }

        for (const candidate of overflow) {
            const updated = await query(`
                UPDATE active_playback_sessions
                SET over_limit_confirmations=over_limit_confirmations+1
                WHERE server_id=$1 AND jellyfin_session_id=$2
                RETURNING over_limit_confirmations,first_seen_at
            `, [candidate.serverId, candidate.sessionId]);
            if (!updated.rowCount) continue;
            candidate.confirmations = Number(updated.rows[0].over_limit_confirmations || 0);
            candidate.firstSeenAt = new Date(updated.rows[0].first_seen_at);
            const ageSeconds = (Date.now() - candidate.firstSeenAt.getTime()) / 1000;

            if (ageSeconds < cfg.graceSeconds) {
                await policyEvent({
                    session: candidate, mode: cfg.effectiveMode, decision: 'pending',
                    streamCount: countable.length, streamLimit, reason: 'grace_period',
                    detail: { ageSeconds: Math.floor(ageSeconds), graceSeconds: cfg.graceSeconds }
                });
                continue;
            }
            if (candidate.confirmations < cfg.confirmationsRequired) {
                await policyEvent({
                    session: candidate, mode: cfg.effectiveMode, decision: 'pending',
                    streamCount: countable.length, streamLimit, reason: 'confirmation_threshold',
                    detail: { confirmations: candidate.confirmations, required: cfg.confirmationsRequired }
                });
                continue;
            }
            if (!pollsReliable) {
                summary.skipped += 1;
                await policyEvent({
                    session: candidate, mode: cfg.effectiveMode, decision: 'skipped_safety',
                    streamCount: countable.length, streamLimit, reason: 'incomplete_server_snapshot'
                });
                continue;
            }
            if (cfg.effectiveMode !== 'enforce') {
                await policyEvent({
                    session: candidate, mode: 'observe', decision: 'would_stop',
                    streamCount: countable.length, streamLimit,
                    reason: cfg.requestedMode === 'enforce' && !cfg.acknowledged
                        ? 'enforcement_ack_missing'
                        : 'observe_only'
                });
                continue;
            }

            if (await stopSessionSafely(candidate, streamLimit, cfg)) summary.stopped += 1;
            else summary.skipped += 1;
        }
    }
    return summary;
}

async function retentionCleanup(cfg) {
    await query(`DELETE FROM playback_history WHERE COALESCE(ended_at,last_seen_at) < NOW() - ($1::int * INTERVAL '1 day')`, [cfg.historyRetentionDays]);
    await query(`DELETE FROM stream_policy_events WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`, [cfg.eventRetentionDays]);
}

async function runActivityPolicyCycle() {
    const cfg = config();
    const pool = getPool();
    const lockClient = await pool.connect();
    let locked = false;
    try {
        const lock = await lockClient.query('SELECT pg_try_advisory_lock($1) AS locked', [ADVISORY_LOCK_ID]);
        locked = Boolean(lock.rows[0]?.locked);
        if (!locked) return { skipped: true, reason: 'another_monitor_is_running' };

        const entitlements = await activeEntitlements();
        const accountsByServer = await managedAccountsByServer();
        const observed = [];
        const failures = [];

        for (const [serverId, accounts] of accountsByServer) {
            try {
                observed.push(...await pollServer(serverId, accounts, entitlements, cfg));
            } catch (error) {
                failures.push({ serverId, error: error.message });
            }
        }

        const policy = await evaluatePolicies(observed, failures.length === 0, cfg);
        await retentionCleanup(cfg);
        return {
            skipped: false,
            mode: cfg.effectiveMode,
            requestedMode: cfg.requestedMode,
            observedStreams: observed.length,
            serverFailures: failures,
            ...policy
        };
    } finally {
        if (locked) {
            try { await lockClient.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]); } catch (_) {}
        }
        lockClient.release();
    }
}

async function listCustomerActivity(customerId, limit = 100) {
    const safeLimit = Math.max(1, Math.min(250, Number(limit) || 100));
    const result = await query(`
        SELECT ph.id,ph.item_name,ph.item_type,ph.client_name,ph.device_name,ph.playback_method,
               ph.transcode_reasons,ph.started_at,ph.last_seen_at,ph.ended_at,ph.ended_reason,
               js.name AS server_name
        FROM playback_history ph
        JOIN jellyfin_servers js ON js.id=ph.server_id
        WHERE ph.customer_id=$1
        ORDER BY ph.started_at DESC
        LIMIT $2
    `, [customerId, safeLimit]);
    return result.rows;
}

async function listCustomerPolicyEvents(customerId, limit = 50) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const result = await query(`
        SELECT decision,mode,stream_count,stream_limit,reason,created_at
        FROM stream_policy_events
        WHERE customer_id=$1
        ORDER BY created_at DESC
        LIMIT $2
    `, [customerId, safeLimit]);
    return result.rows;
}

module.exports = {
    ENFORCEMENT_ACK,
    config,
    effectiveStreamLimit,
    runActivityPolicyCycle,
    listCustomerActivity,
    listCustomerPolicyEvents,
    activeEntitlements
};