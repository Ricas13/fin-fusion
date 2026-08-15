BEGIN;

-- A provider-confirmed checkout must remain the contract that is fulfilled even
-- when an administrator edits or archives the catalogue while the customer is
-- on the provider's hosted payment page. Persist the complete sold policy on
-- the resulting subscription, not only price/duration fragments.
ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS commercial_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Rebuild the one canonical entitlement view so a checkout-backed subscription
-- consumes the policy captured at sale time. Legacy/manual subscriptions fall
-- back to their existing snapshot columns and then the current catalogue row.
CREATE OR REPLACE VIEW effective_customer_entitlements AS
SELECT DISTINCT ON (s.customer_id)
    s.customer_id,
    s.id AS subscription_id,
    s.plan_id,
    s.status,
    s.source,
    s.starts_at,
    s.current_period_end,
    COALESCE(s.service_extension_days,0) AS service_extension_days,
    s.current_period_end + (COALESCE(s.service_extension_days,0)||' days')::interval AS access_expires_at,
    s.cancel_at_period_end,
    s.provider_customer_id,
    s.provider_subscription_id,
    COALESCE(NULLIF(s.commercial_snapshot->>'planName',''),s.plan_name_snapshot,p.name) AS plan_name_snapshot,
    COALESCE(NULLIF(s.commercial_snapshot->>'planCode',''),s.plan_code_snapshot,p.code) AS plan_code_snapshot,
    COALESCE(CASE WHEN (s.commercial_snapshot->>'priceMinor') ~ '^-?[0-9]+$' THEN (s.commercial_snapshot->>'priceMinor')::int END,s.price_minor_snapshot,p.price_minor) AS price_minor_snapshot,
    COALESCE(NULLIF(s.commercial_snapshot->>'currency',''),s.currency_snapshot::text,p.currency::text)::CHAR(3) AS currency_snapshot,
    COALESCE(NULLIF(s.commercial_snapshot->>'billingInterval',''),s.billing_interval_snapshot,p.billing_interval) AS billing_interval_snapshot,
    COALESCE(CASE WHEN (s.commercial_snapshot->>'durationDays') ~ '^[0-9]+$' THEN (s.commercial_snapshot->>'durationDays')::int END,s.duration_days_snapshot,p.duration_days) AS duration_days_snapshot,
    COALESCE(NULLIF(s.commercial_snapshot->>'providerMappingId',''),s.provider_price_id_snapshot) AS provider_price_id_snapshot,
    COALESCE(NULLIF(s.commercial_snapshot->>'planCode',''),s.plan_code_snapshot,p.code) AS code,
    COALESCE(NULLIF(s.commercial_snapshot->>'planName',''),s.plan_name_snapshot,p.name) AS name,
    p.audience,
    COALESCE(NULLIF(s.commercial_snapshot->>'billingInterval',''),s.billing_interval_snapshot,p.billing_interval) AS billing_interval,
    COALESCE(CASE WHEN (s.commercial_snapshot->>'durationDays') ~ '^[0-9]+$' THEN (s.commercial_snapshot->>'durationDays')::int END,s.duration_days_snapshot,p.duration_days) AS duration_days,
    COALESCE(CASE WHEN (s.commercial_snapshot->>'priceMinor') ~ '^-?[0-9]+$' THEN (s.commercial_snapshot->>'priceMinor')::int END,s.price_minor_snapshot,p.price_minor) AS price_minor,
    COALESCE(NULLIF(s.commercial_snapshot->>'currency',''),s.currency_snapshot::text,p.currency::text)::CHAR(3) AS currency,
    COALESCE(CASE WHEN (s.commercial_snapshot->>'streams') ~ '^[0-9]+$' THEN (s.commercial_snapshot->>'streams')::int END,p.streams) AS streams,
    CASE WHEN s.commercial_snapshot ? 'allowDownloads' THEN (s.commercial_snapshot->>'allowDownloads')::boolean ELSE p.allow_downloads END AS allow_downloads,
    CASE WHEN s.commercial_snapshot ? 'allowVideoTranscoding' THEN (s.commercial_snapshot->>'allowVideoTranscoding')::boolean ELSE p.allow_video_transcoding END AS allow_video_transcoding,
    CASE WHEN s.commercial_snapshot ? 'allowAudioTranscoding' THEN (s.commercial_snapshot->>'allowAudioTranscoding')::boolean ELSE p.allow_audio_transcoding END AS allow_audio_transcoding,
    CASE WHEN s.commercial_snapshot ? 'allowLiveTv' THEN (s.commercial_snapshot->>'allowLiveTv')::boolean ELSE p.allow_live_tv END AS allow_live_tv,
    CASE WHEN s.commercial_snapshot ? 'allowLiveTvManagement' THEN (s.commercial_snapshot->>'allowLiveTvManagement')::boolean ELSE p.allow_live_tv_management END AS allow_live_tv_management,
    COALESCE(NULLIF(s.commercial_snapshot->>'serverClass',''),p.server_class) AS server_class,
    COALESCE(CASE WHEN (s.commercial_snapshot->>'requestMovieQuotaLimit') ~ '^[0-9]+$' THEN (s.commercial_snapshot->>'requestMovieQuotaLimit')::int END,p.request_movie_quota_limit) AS request_movie_quota_limit,
    COALESCE(CASE WHEN (s.commercial_snapshot->>'requestMovieQuotaDays') ~ '^[0-9]+$' THEN (s.commercial_snapshot->>'requestMovieQuotaDays')::int END,p.request_movie_quota_days) AS request_movie_quota_days,
    COALESCE(CASE WHEN (s.commercial_snapshot->>'requestTvQuotaLimit') ~ '^[0-9]+$' THEN (s.commercial_snapshot->>'requestTvQuotaLimit')::int END,p.request_tv_quota_limit) AS request_tv_quota_limit,
    COALESCE(CASE WHEN (s.commercial_snapshot->>'requestTvQuotaDays') ~ '^[0-9]+$' THEN (s.commercial_snapshot->>'requestTvQuotaDays')::int END,p.request_tv_quota_days) AS request_tv_quota_days,
    EXISTS (
        SELECT 1 FROM customer_access_holds h
        WHERE h.customer_id=s.customer_id AND h.released_at IS NULL
    ) AS blocked
FROM subscriptions s
JOIN plans p ON p.id=s.plan_id
WHERE s.superseded_by IS NULL
  AND s.starts_at<=NOW()
  AND (
      (s.status IN ('active','trialing','past_due','paused') AND s.current_period_end>NOW())
      OR (
          COALESCE(s.service_extension_days,0)>0
          AND s.status IN ('active','trialing','past_due','paused','cancelled','expired')
          AND s.current_period_end+(s.service_extension_days||' days')::interval>NOW()
      )
  )
ORDER BY s.customer_id,
         (s.current_period_end+(COALESCE(s.service_extension_days,0)||' days')::interval) DESC,
         s.created_at DESC;

COMMIT;
