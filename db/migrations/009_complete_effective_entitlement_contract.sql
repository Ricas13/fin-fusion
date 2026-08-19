-- Complete the primary effective-entitlement contract used by provisioning.
--
-- The baseline view historically omitted newer plan fields even though runtime
-- policy code consumes them. Missing booleans were therefore interpreted as
-- false and missing library policy as unrestricted/all. Add the fields at the
-- END of the existing view contract so CREATE OR REPLACE remains compatible
-- with existing dependent objects while fresh installs and upgrades converge.

CREATE OR REPLACE VIEW effective_customer_entitlements AS
 SELECT DISTINCT ON (s.customer_id) s.customer_id,
    s.id AS subscription_id,
    s.plan_id,
    s.status,
    s.source,
    s.starts_at,
    s.current_period_end,
    COALESCE(s.service_extension_days, 0) AS service_extension_days,
    CASE WHEN (o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id)
         THEN 'infinity'::timestamptz
         ELSE (s.current_period_end + ((COALESCE(s.service_extension_days, 0) || ' days'::text))::interval)
    END AS access_expires_at,
    s.cancel_at_period_end,
    s.provider_customer_id,
    s.provider_subscription_id,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'planName'::text), ''::text), s.plan_name_snapshot, p.name) AS plan_name_snapshot,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'planCode'::text), ''::text), s.plan_code_snapshot, p.code) AS plan_code_snapshot,
    COALESCE(CASE WHEN ((s.commercial_snapshot ->> 'priceMinor'::text) ~ '^-?[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'priceMinor'::text))::integer ELSE NULL::integer END, s.price_minor_snapshot, p.price_minor) AS price_minor_snapshot,
    (COALESCE(NULLIF((s.commercial_snapshot ->> 'currency'::text), ''::text), (s.currency_snapshot)::text, (p.currency)::text))::character(3) AS currency_snapshot,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'billingInterval'::text), ''::text), s.billing_interval_snapshot, p.billing_interval) AS billing_interval_snapshot,
    COALESCE(CASE WHEN ((s.commercial_snapshot ->> 'durationDays'::text) ~ '^[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'durationDays'::text))::integer ELSE NULL::integer END, s.duration_days_snapshot, p.duration_days) AS duration_days_snapshot,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'providerMappingId'::text), ''::text), s.provider_price_id_snapshot) AS provider_price_id_snapshot,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'planCode'::text), ''::text), s.plan_code_snapshot, p.code) AS code,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'planName'::text), ''::text), s.plan_name_snapshot, p.name) AS name,
    p.audience,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'billingInterval'::text), ''::text), s.billing_interval_snapshot, p.billing_interval) AS billing_interval,
    COALESCE(CASE WHEN ((s.commercial_snapshot ->> 'durationDays'::text) ~ '^[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'durationDays'::text))::integer ELSE NULL::integer END, s.duration_days_snapshot, p.duration_days) AS duration_days,
    COALESCE(CASE WHEN ((s.commercial_snapshot ->> 'priceMinor'::text) ~ '^-?[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'priceMinor'::text))::integer ELSE NULL::integer END, s.price_minor_snapshot, p.price_minor) AS price_minor,
    (COALESCE(NULLIF((s.commercial_snapshot ->> 'currency'::text), ''::text), (s.currency_snapshot)::text, (p.currency)::text))::character(3) AS currency,
    COALESCE(CASE WHEN ((s.commercial_snapshot ->> 'streams'::text) ~ '^[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'streams'::text))::integer ELSE NULL::integer END, p.streams) AS streams,
    CASE WHEN (s.commercial_snapshot ? 'allowDownloads'::text) THEN ((s.commercial_snapshot ->> 'allowDownloads'::text))::boolean ELSE p.allow_downloads END AS allow_downloads,
    CASE WHEN (s.commercial_snapshot ? 'allowVideoTranscoding'::text) THEN ((s.commercial_snapshot ->> 'allowVideoTranscoding'::text))::boolean ELSE p.allow_video_transcoding END AS allow_video_transcoding,
    CASE WHEN (s.commercial_snapshot ? 'allowAudioTranscoding'::text) THEN ((s.commercial_snapshot ->> 'allowAudioTranscoding'::text))::boolean ELSE p.allow_audio_transcoding END AS allow_audio_transcoding,
    CASE WHEN (s.commercial_snapshot ? 'allowLiveTv'::text) THEN ((s.commercial_snapshot ->> 'allowLiveTv'::text))::boolean ELSE p.allow_live_tv END AS allow_live_tv,
    CASE WHEN (s.commercial_snapshot ? 'allowLiveTvManagement'::text) THEN ((s.commercial_snapshot ->> 'allowLiveTvManagement'::text))::boolean ELSE p.allow_live_tv_management END AS allow_live_tv_management,
    COALESCE(NULLIF((s.commercial_snapshot ->> 'serverClass'::text), ''::text), p.server_class) AS server_class,
    COALESCE(CASE WHEN ((s.commercial_snapshot ->> 'requestMovieQuotaLimit'::text) ~ '^[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'requestMovieQuotaLimit'::text))::integer ELSE NULL::integer END, p.request_movie_quota_limit) AS request_movie_quota_limit,
    COALESCE(CASE WHEN ((s.commercial_snapshot ->> 'requestMovieQuotaDays'::text) ~ '^[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'requestMovieQuotaDays'::text))::integer ELSE NULL::integer END, p.request_movie_quota_days) AS request_movie_quota_days,
    COALESCE(CASE WHEN ((s.commercial_snapshot ->> 'requestTvQuotaLimit'::text) ~ '^[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'requestTvQuotaLimit'::text))::integer ELSE NULL::integer END, p.request_tv_quota_limit) AS request_tv_quota_limit,
    COALESCE(CASE WHEN ((s.commercial_snapshot ->> 'requestTvQuotaDays'::text) ~ '^[0-9]+$'::text) THEN ((s.commercial_snapshot ->> 'requestTvQuotaDays'::text))::integer ELSE NULL::integer END, p.request_tv_quota_days) AS request_tv_quota_days,
    (EXISTS (SELECT 1 FROM customer_access_holds h WHERE h.customer_id=s.customer_id AND h.released_at IS NULL)) AS blocked,
    s.service_type_snapshot,
    p.service_type,
    p.allow_remuxing,
    p.allow_remote_access,
    p.allow_4k,
    p.library_access_mode,
    p.library_names,
    p.placement_strategy,
    p.capacity_limit,
    p.is_free_tier,
    p.inactivity_policy,
    p.marketing_features
   FROM subscriptions s
   JOIN plans p ON p.id=s.plan_id
   LEFT JOIN customer_entitlement_overrides o ON o.customer_id=s.customer_id AND o.subscription_id=s.id
  WHERE COALESCE(p.is_addon,FALSE)=FALSE
    AND s.superseded_by IS NULL
    AND s.starts_at<=NOW()
    AND (
      (o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id)
      OR (s.status IN ('active','trialing','past_due','paused') AND s.current_period_end>NOW())
      OR (COALESCE(s.service_extension_days,0)>0 AND s.status IN ('active','trialing','past_due','paused','cancelled','expired') AND (s.current_period_end + ((s.service_extension_days || ' days'::text))::interval)>NOW())
    )
  ORDER BY s.customer_id,
    (CASE WHEN (o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id) THEN 'infinity'::timestamptz ELSE (s.current_period_end + ((COALESCE(s.service_extension_days,0) || ' days'::text))::interval) END) DESC,
    s.created_at DESC;

COMMENT ON VIEW effective_customer_entitlements IS 'Current primary customer entitlement including complete service, Jellyfin policy, library, placement and administrator permanent-access semantics.';
