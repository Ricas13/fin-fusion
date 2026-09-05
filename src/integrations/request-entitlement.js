'use strict';

const {query}=require('../db');

// Request access is a cross-service benefit. A customer may have Jellyfin,
// Stremio and Emby subscriptions at the same time, so request provisioning must
// not rely on the Jellyfin-only effective_customer_entitlements view.
//
// Overseerr admin authority is service-scoped and must be absolute. When an
// administrator explicitly forces Overseerr present, a still-current lane is
// preferred, but the most recent historical non-addon plan may also supply the
// request policy after the paid subscription has expired/been refunded. This
// lets admin_present keep the service alive without inventing policy from
// nowhere. A customer who has never had a suitable plan still needs a manual
// plan grant so quotas/permissions have an authoritative policy source.
async function resolve(customerId){
  const result=await query(`
    WITH admin_authority AS (
      SELECT mode
      FROM customer_service_admin_control
      WHERE customer_id=$1 AND service='overseerr'
      LIMIT 1
    ),
    lane_entitlements AS (
      SELECT customer_id,subscription_id,plan_id,access_expires_at,blocked,0 AS service_rank
      FROM effective_customer_entitlements
      WHERE customer_id=$1
      UNION ALL
      SELECT customer_id,subscription_id,plan_id,access_expires_at,blocked,1 AS service_rank
      FROM effective_stremio_entitlements
      WHERE customer_id=$1
      UNION ALL
      SELECT customer_id,subscription_id,plan_id,access_expires_at,blocked,2 AS service_rank
      FROM effective_emby_entitlements
      WHERE customer_id=$1
    ),
    historical_admin_entitlements AS (
      SELECT s.customer_id,s.id AS subscription_id,s.plan_id,
        s.current_period_end+((COALESCE(s.service_extension_days,0)||' days')::interval) AS access_expires_at,
        FALSE AS blocked,9 AS service_rank
      FROM subscriptions s
      JOIN plans p ON p.id=s.plan_id
      WHERE s.customer_id=$1
        AND s.superseded_by IS NULL
        AND COALESCE(p.is_addon,FALSE)=FALSE
        AND COALESCE(p.request_access_enabled,TRUE)=TRUE
        AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('jellyfin','stremio','emby','bundle')
        AND EXISTS(SELECT 1 FROM admin_authority a WHERE a.mode='admin_present')
        AND NOT EXISTS(SELECT 1 FROM lane_entitlements le WHERE le.subscription_id=s.id)
    ),
    candidate_entitlements AS (
      SELECT * FROM lane_entitlements
      UNION ALL
      SELECT * FROM historical_admin_entitlements
    )
    SELECT e.customer_id,e.subscription_id,e.plan_id,
      p.name AS plan_name,p.code AS plan_code,e.access_expires_at AS current_period_end,
      COALESCE(CASE WHEN ((s.commercial_snapshot->>'requestMovieQuotaLimit') ~ '^[0-9]+$') THEN (s.commercial_snapshot->>'requestMovieQuotaLimit')::int END,p.request_movie_quota_limit) AS request_movie_quota_limit,
      COALESCE(CASE WHEN ((s.commercial_snapshot->>'requestMovieQuotaDays') ~ '^[0-9]+$') THEN (s.commercial_snapshot->>'requestMovieQuotaDays')::int END,p.request_movie_quota_days,
      COALESCE(CASE WHEN ((s.commercial_snapshot->>'requestTvQuotaLimit') ~ '^[0-9]+$') THEN (s.commercial_snapshot->>'requestTvQuotaLimit')::int END,p.request_tv_quota_limit) AS request_tv_quota_limit,
      COALESCE(CASE WHEN ((s.commercial_snapshot->>'requestTvQuotaDays') ~ '^[0-9]+$') THEN (s.commercial_snapshot->>'requestTvQuotaDays')::int END,p.request_tv_quota_days) AS request_tv_quota_days,
      p.request_permissions,p.request_watchlist_sync_movies,p.request_watchlist_sync_tv,
      p.request_locale,p.request_discover_region,p.request_streaming_region,p.request_original_language,
      TRUE AS request_access_enabled,
      (e.subscription_id IS NOT NULL
        AND NOT public.subscription_admin_removed(e.customer_id,'overseerr')
        AND (e.blocked=FALSE OR public.subscription_admin_present(e.customer_id,'overseerr',e.subscription_id))) AS entitlement_active
    FROM candidate_entitlements e
    JOIN plans p ON p.id=e.plan_id
    JOIN subscriptions s ON s.id=e.subscription_id
    WHERE COALESCE(p.request_access_enabled,TRUE)=TRUE
    ORDER BY
      CASE WHEN public.subscription_admin_present(e.customer_id,'overseerr',e.subscription_id) THEN 0 ELSE 1 END,
      e.blocked ASC,e.service_rank ASC,e.access_expires_at DESC,s.created_at DESC
    LIMIT 1
  `,[customerId]);
  return result.rows[0]||null;
}

module.exports={resolve};
