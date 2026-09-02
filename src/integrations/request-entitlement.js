'use strict';

const {query}=require('../db');

// Request access is a cross-service benefit. A customer may have Jellyfin,
// Stremio and Emby subscriptions at the same time, so request provisioning must
// not rely on the Jellyfin-only effective_customer_entitlements view.
async function resolve(customerId){
  const result=await query(`
    WITH lane_entitlements AS (
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
    )
    SELECT e.customer_id,e.subscription_id,e.plan_id,
      p.name AS plan_name,p.code AS plan_code,e.access_expires_at AS current_period_end,
      COALESCE(CASE WHEN ((s.commercial_snapshot->>'requestMovieQuotaLimit') ~ '^[0-9]+$') THEN (s.commercial_snapshot->>'requestMovieQuotaLimit')::int END,p.request_movie_quota_limit) AS request_movie_quota_limit,
      COALESCE(CASE WHEN ((s.commercial_snapshot->>'requestMovieQuotaDays') ~ '^[0-9]+$') THEN (s.commercial_snapshot->>'requestMovieQuotaDays')::int END,p.request_movie_quota_days) AS request_movie_quota_days,
      COALESCE(CASE WHEN ((s.commercial_snapshot->>'requestTvQuotaLimit') ~ '^[0-9]+$') THEN (s.commercial_snapshot->>'requestTvQuotaLimit')::int END,p.request_tv_quota_limit) AS request_tv_quota_limit,
      COALESCE(CASE WHEN ((s.commercial_snapshot->>'requestTvQuotaDays') ~ '^[0-9]+$') THEN (s.commercial_snapshot->>'requestTvQuotaDays')::int END,p.request_tv_quota_days) AS request_tv_quota_days,
      p.request_permissions,p.request_watchlist_sync_movies,p.request_watchlist_sync_tv,
      p.request_locale,p.request_discover_region,p.request_streaming_region,p.request_original_language,
      TRUE AS request_access_enabled,
      (e.subscription_id IS NOT NULL AND e.blocked=FALSE) AS entitlement_active
    FROM lane_entitlements e
    JOIN plans p ON p.id=e.plan_id
    JOIN subscriptions s ON s.id=e.subscription_id
    WHERE COALESCE(p.request_access_enabled,TRUE)=TRUE
    ORDER BY e.blocked ASC,e.service_rank ASC,e.access_expires_at DESC
    LIMIT 1
  `,[customerId]);
  return result.rows[0]||null;
}

module.exports={resolve};
