'use strict';

const { query } = require('../db');
const lifecyclePolicy = require('../entitlements/jellyfin-lifecycle-policy');

const HOLD_TYPE = 'inactivity_policy';
const FREE_POLICY_DEFAULTS = Object.freeze({
    firstPlaybackGraceDays: 3,
    playbackWindowDays: 7,
    minimumPlaybackMinutes: 30
});

function asDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function boundedInt(value, min, max, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function serverPolicy(row = {}, globalCfg = {}) {
    return {
        enabled: Boolean(globalCfg.enabled),
        dryRun: Boolean(globalCfg.dryRun),
        firstPlaybackGraceDays: boundedInt(
            row.free_first_playback_grace_days,
            1,
            3650,
            FREE_POLICY_DEFAULTS.firstPlaybackGraceDays
        ),
        playbackWindowDays: boundedInt(
            row.free_playback_window_days,
            1,
            365,
            FREE_POLICY_DEFAULTS.playbackWindowDays
        ),
        minimumPlaybackMinutes: boundedInt(
            row.free_minimum_playback_minutes,
            1,
            1000000,
            FREE_POLICY_DEFAULTS.minimumPlaybackMinutes
        ),
        thresholdOwner: 'free_server'
    };
}

function assessUsage(row, policy, now = Date.now()) {
    const allocationStartAt = asDate(row.allocation_start_at)
        || asDate(row.account_created_at)
        || asDate(row.starts_at);
    const rawFirstPlaybackAt = asDate(row.first_playback_at);
    const rawLastPlaybackAt = asDate(row.last_playback_at);
    const firstPlaybackAt = rawFirstPlaybackAt
        && (!allocationStartAt || rawFirstPlaybackAt >= allocationStartAt)
        ? rawFirstPlaybackAt
        : null;
    const lastPlaybackAt = rawLastPlaybackAt
        && (!allocationStartAt || rawLastPlaybackAt >= allocationStartAt)
        ? rawLastPlaybackAt
        : null;
    const hasPlayback = Boolean(firstPlaybackAt || lastPlaybackAt);
    const effectiveFirstPlaybackAt = firstPlaybackAt || lastPlaybackAt;
    const seconds = Math.max(0, Number(row.playback_seconds || 0));

    const firstPlaybackDeadline = allocationStartAt
        ? allocationStartAt.getTime() + policy.firstPlaybackGraceDays * 86400000
        : null;
    const firstPlaybackOnTime = Boolean(
        effectiveFirstPlaybackAt
        && (
            firstPlaybackDeadline == null
            || effectiveFirstPlaybackAt.getTime() <= firstPlaybackDeadline
        )
    );
    const retentionReadyAt = firstPlaybackOnTime
        ? effectiveFirstPlaybackAt.getTime() + policy.playbackWindowDays * 86400000
        : null;

    // Rule 1 is deadline-based, not worker-run-based. A first playback that
    // happens after the grace deadline must not retroactively activate the
    // allocation just because the inactivity worker had not run yet.
    const firstPlaybackEligible = Boolean(
        firstPlaybackDeadline != null
        && now >= firstPlaybackDeadline
        && !firstPlaybackOnTime
    );
    const usageEligible = Boolean(
        firstPlaybackOnTime
        && retentionReadyAt != null
        && now >= retentionReadyAt
        && seconds < policy.minimumPlaybackMinutes * 60
    );

    return {
        allocationStartAt,
        firstPlaybackAt: effectiveFirstPlaybackAt,
        lastPlaybackAt,
        lastActivityAt: asDate(row.last_activity_at), // display only; never retention authority
        hasPlayback,
        firstPlaybackOnTime,
        referenceAt: lastPlaybackAt || allocationStartAt,
        observationStartedAt: hasPlayback ? effectiveFirstPlaybackAt : allocationStartAt,
        seconds,
        firstPlaybackEligible,
        usageEligible
    };
}

async function candidates(globalCfg = null, { customerId = null } = {}) {
    globalCfg = globalCfg || await lifecyclePolicy.get();
    if (!globalCfg.enabled) return [];

    const result = await query(`
        WITH free_access AS (
          SELECT DISTINCT ON (s.customer_id)
            s.customer_id,
            s.id subscription_id,
            s.plan_id,
            s.starts_at,
            s.current_period_end,
            s.created_at subscription_created_at,
            p.code plan_code,
            p.name plan_name
          FROM subscriptions s
          JOIN plans p ON p.id=s.plan_id
          WHERE s.superseded_by IS NULL
            AND s.starts_at<=NOW()
            AND (
              (
                s.status IN ('active','trialing','past_due','paused')
                AND s.current_period_end>NOW()
              )
              OR (
                COALESCE(s.service_extension_days,0)>0
                AND s.status IN ('active','trialing','past_due','paused','cancelled','expired')
                AND s.current_period_end+((s.service_extension_days||' days')::interval)>NOW()
              )
            )
            AND p.is_free_tier=TRUE
            AND p.price_minor=0
            AND COALESCE(p.is_addon,FALSE)=FALSE
            AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('jellyfin','bundle')
            AND ($2::uuid IS NULL OR s.customer_id=$2::uuid)
          ORDER BY s.customer_id,s.created_at DESC
        )
        SELECT
          fa.*,
          ja.id account_id,
          ja.server_id,
          ja.jellyfin_user_id,
          ja.jellyfin_username,
          ja.created_at account_created_at,
          ja.access_lane_changed_at,
          ja.inactivity_observation_reset_at,
          ja.last_activity_at,
          allocation.allocation_start_at,
          js.name server_name,
          js.free_first_playback_grace_days,
          js.free_playback_window_days,
          js.free_minimum_playback_minutes,
          COALESCE(c.display_name,u.username,c.email,'Customer') customer_name,
          COALESCE(c.email,u.email) email,
          EXISTS(
            SELECT 1
            FROM customer_entitlement_overrides active_override
            WHERE active_override.customer_id=fa.customer_id
              AND active_override.subscription_id=fa.subscription_id
              AND active_override.permanent_access=TRUE
              AND active_override.revoked_at IS NULL
          ) permanent_access,
          admin_ctl.mode admin_jellyfin_mode,
          us.first_playback_at,
          us.last_playback_at,
          COALESCE(us.playback_seconds,0)::bigint playback_seconds,
          EXISTS(
            SELECT 1 FROM active_playback_sessions aps
            WHERE aps.jellyfin_account_id=ja.id
          ) currently_playing,
          EXISTS(
            SELECT 1 FROM customer_access_holds h
            WHERE h.customer_id=fa.customer_id
              AND h.hold_type=$1
              AND h.source_key=('plan:'||fa.plan_id::text)
              AND h.released_at IS NULL
              AND (
                h.metadata->>'subscriptionId'=fa.subscription_id::text
                OR (
                  h.metadata->>'subscriptionId' IS NULL
                  AND h.created_at>=fa.subscription_created_at
                )
              )
          ) already_held
        FROM free_access fa
        JOIN customers c ON c.id=fa.customer_id
        LEFT JOIN app_users u ON u.id=c.user_id
        LEFT JOIN customer_service_admin_control admin_ctl
          ON admin_ctl.customer_id=fa.customer_id
         AND admin_ctl.service='jellyfin'
        JOIN jellyfin_accounts ja
          ON ja.customer_id=fa.customer_id
         AND ja.account_purpose='jellyfin'
         AND ja.access_lane='free'
         AND ja.disabled=FALSE
        JOIN jellyfin_servers js ON js.id=ja.server_id
        LEFT JOIN LATERAL (
          SELECT MAX(revoked_at) resumed_at
          FROM customer_entitlement_overrides ceo
          WHERE ceo.customer_id=fa.customer_id
            AND ceo.subscription_id=fa.subscription_id
            AND ceo.permanent_access=FALSE
            AND ceo.revoked_at IS NOT NULL
            AND ceo.revoked_at<=NOW()
        ) automation_resume ON TRUE
        LEFT JOIN LATERAL (
          SELECT GREATEST(
            fa.starts_at,
            ja.created_at,
            ja.access_lane_changed_at,
            COALESCE(automation_resume.resumed_at,'-infinity'::timestamptz)
          ) allocation_start_at
        ) allocation ON TRUE
        LEFT JOIN LATERAL (
          SELECT
            MIN(ph.started_at) FILTER (
              WHERE ph.started_at>=allocation.allocation_start_at
                AND ph.started_at<NOW()
            ) first_playback_at,
            MAX(COALESCE(ph.ended_at,ph.last_seen_at,ph.started_at)) FILTER (
              WHERE ph.started_at>=allocation.allocation_start_at
                AND ph.started_at<NOW()
            ) last_playback_at,
            COALESCE(SUM(
              GREATEST(
                0,
                EXTRACT(EPOCH FROM (
                  LEAST(COALESCE(ph.ended_at,ph.last_seen_at),NOW())
                  - GREATEST(
                      ph.started_at,
                      NOW()-(js.free_playback_window_days||' days')::interval
                    )
                ))
              )
            ) FILTER (
              WHERE ph.started_at>=allocation.allocation_start_at
                AND COALESCE(ph.ended_at,ph.last_seen_at)>NOW()-(js.free_playback_window_days||' days')::interval
                AND ph.started_at<NOW()
            ),0)::bigint playback_seconds
          FROM playback_history ph
          WHERE ph.customer_id=fa.customer_id
            AND ph.server_id=ja.server_id
            AND (ph.jellyfin_account_id=ja.id OR ph.jellyfin_account_id IS NULL)
        ) us ON TRUE
        WHERE NOT EXISTS(
          SELECT 1 FROM customer_bans b
          WHERE b.customer_id=fa.customer_id
            AND b.revoked_at IS NULL
            AND b.blocks_service_access=TRUE
        )
        ORDER BY COALESCE(us.last_playback_at,allocation.allocation_start_at),customer_name
    `, [HOLD_TYPE, customerId || null]);

    return result.rows.map(row => {
        const policy = serverPolicy(row, globalCfg);
        const assessment = assessUsage(row, policy);
        const usageTriggered = assessment.firstPlaybackEligible || assessment.usageEligible;
        const adminProtected = Boolean(
            row.permanent_access
            || String(row.admin_jellyfin_mode || '') === 'admin_present'
        );
        const adminRemoved = String(row.admin_jellyfin_mode || '') === 'admin_removed';
        const eligible = policy.enabled
            && !row.currently_playing
            && !adminProtected
            && !adminRemoved
            && usageTriggered;
        const triggers = [];

        if (assessment.firstPlaybackEligible) {
            triggers.push(`no first Free Server playback within ${policy.firstPlaybackGraceDays} day(s) of this allocation`);
        }
        if (assessment.usageEligible) {
            triggers.push(
                `${Math.floor(assessment.seconds / 60)} min played on Free Server in ${policy.playbackWindowDays} day(s), below ${policy.minimumPlaybackMinutes} min`
            );
        }

        const reasons = [];
        if (!policy.enabled) reasons.push('Free Server inactivity automation is paused');
        if (row.currently_playing) reasons.push('currently playing on Free Server');
        if (adminProtected) reasons.push('explicit admin/permanent protection');
        if (adminRemoved) reasons.push('Jellyfin access already marked removed by administrator');
        if (policy.enabled && !usageTriggered) {
            reasons.push(
                assessment.hasPlayback
                    ? 'rolling Free Server playback requirement is satisfied or the first playback is still inside its initial window'
                    : 'first-play grace period has not expired'
            );
        }

        return {
            ...row,
            policy,
            first_playback_at: assessment.firstPlaybackAt,
            last_playback_at: assessment.lastPlaybackAt,
            last_activity_at: assessment.lastActivityAt,
            allocation_start_at: assessment.allocationStartAt,
            playback_seconds: assessment.seconds,
            inactive_reference_at: assessment.referenceAt,
            observation_started_at: assessment.observationStartedAt,
            has_playback: assessment.hasPlayback,
            first_playback_on_time: assessment.firstPlaybackOnTime,
            admin_protected: adminProtected,
            eligible,
            repairExistingHold: Boolean(row.already_held && eligible),
            triggers,
            reasons
        };
    });
}

module.exports = {
    HOLD_TYPE,
    FREE_POLICY_DEFAULTS,
    serverPolicy,
    assessUsage,
    candidates
};
