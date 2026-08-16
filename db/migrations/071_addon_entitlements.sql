BEGIN;

-- A customer may have one primary access contract plus independently billed
-- add-ons. Preserve the canonical checkout-snapshot semantics introduced by
-- migration 061; the only primary-view change here is excluding add-on plans.
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
WHERE COALESCE(p.is_addon,FALSE)=FALSE
  AND s.superseded_by IS NULL
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

-- Unlike the primary view, every live add-on remains independently visible.
-- Use the same sold-contract policy projection as the primary entitlement so a
-- later catalogue edit cannot rewrite an already-purchased add-on either.
CREATE OR REPLACE VIEW effective_customer_addons AS
SELECT
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
    s.service_type_snapshot,
    COALESCE(NULLIF(s.commercial_snapshot->>'planCode',''),s.plan_code_snapshot,p.code) AS code,
    COALESCE(NULLIF(s.commercial_snapshot->>'planName',''),s.plan_name_snapshot,p.name) AS name,
    p.audience,
    COALESCE(NULLIF(s.commercial_snapshot->>'billingInterval',''),s.billing_interval_snapshot,p.billing_interval) AS billing_interval,
    COALESCE(CASE WHEN (s.commercial_snapshot->>'durationDays') ~ '^[0-9]+$' THEN (s.commercial_snapshot->>'durationDays')::int END,s.duration_days_snapshot,p.duration_days) AS duration_days,
    COALESCE(CASE WHEN (s.commercial_snapshot->>'priceMinor') ~ '^-?[0-9]+$' THEN (s.commercial_snapshot->>'priceMinor')::int END,s.price_minor_snapshot,p.price_minor) AS price_minor,
    COALESCE(NULLIF(s.commercial_snapshot->>'currency',''),s.currency_snapshot::text,p.currency::text)::CHAR(3) AS currency,
    COALESCE(CASE WHEN (s.commercial_snapshot->>'streams') ~ '^[0-9]+$' THEN (s.commercial_snapshot->>'streams')::int END,p.streams) AS streams,
    p.service_type,
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
WHERE p.is_addon=TRUE
  AND s.superseded_by IS NULL
  AND s.starts_at<=NOW()
  AND (
      (s.status IN ('active','trialing','past_due','paused') AND s.current_period_end>NOW())
      OR (
          COALESCE(s.service_extension_days,0)>0
          AND s.status IN ('active','trialing','past_due','paused','cancelled','expired')
          AND s.current_period_end+(s.service_extension_days||' days')::interval>NOW()
      )
  );

-- Recurring provider agreements are singular for the primary contract. Add-ons
-- may coexist, but the same add-on plan cannot be subscribed twice at once.
CREATE OR REPLACE FUNCTION enforce_single_live_customer_recurring_subscription()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    new_is_addon BOOLEAN := FALSE;
BEGIN
    IF NEW.source IN ('stripe','paypal')
       AND NEW.status IN ('active','trialing','past_due','paused')
       AND NEW.current_period_end > NOW()
       AND ((NEW.source='stripe' AND LEFT(COALESCE(NEW.provider_subscription_id,''),4)='sub_')
         OR (NEW.source='paypal' AND LEFT(COALESCE(NEW.provider_subscription_id,''),2)='I-')) THEN

        SELECT COALESCE(is_addon,FALSE) INTO new_is_addon
          FROM plans WHERE id=NEW.plan_id;

        IF new_is_addon THEN
            IF EXISTS (
                SELECT 1 FROM subscriptions s
                WHERE s.customer_id=NEW.customer_id
                  AND s.id<>NEW.id
                  AND s.plan_id=NEW.plan_id
                  AND s.superseded_by IS NULL
                  AND s.source IN ('stripe','paypal')
                  AND s.status IN ('active','trialing','past_due','paused')
                  AND s.current_period_end>NOW()
                  AND ((s.source='stripe' AND LEFT(COALESCE(s.provider_subscription_id,''),4)='sub_')
                    OR (s.source='paypal' AND LEFT(COALESCE(s.provider_subscription_id,''),2)='I-'))
            ) THEN
                RAISE EXCEPTION 'Customer already has a live recurring subscription for this add-on';
            END IF;
        ELSIF EXISTS (
            SELECT 1 FROM subscriptions s
            JOIN plans existing_plan ON existing_plan.id=s.plan_id
            WHERE s.customer_id=NEW.customer_id
              AND s.id<>NEW.id
              AND COALESCE(existing_plan.is_addon,FALSE)=FALSE
              AND s.superseded_by IS NULL
              AND s.source IN ('stripe','paypal')
              AND s.status IN ('active','trialing','past_due','paused')
              AND s.current_period_end>NOW()
              AND ((s.source='stripe' AND LEFT(COALESCE(s.provider_subscription_id,''),4)='sub_')
                OR (s.source='paypal' AND LEFT(COALESCE(s.provider_subscription_id,''),2)='I-'))
        ) THEN
            RAISE EXCEPTION 'Customer already has a live recurring primary provider subscription';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS single_live_customer_recurring_subscription_trigger ON subscriptions;
CREATE TRIGGER single_live_customer_recurring_subscription_trigger
BEFORE INSERT OR UPDATE OF customer_id,plan_id,status,source,current_period_end,provider_subscription_id,superseded_by
ON subscriptions FOR EACH ROW EXECUTE FUNCTION enforce_single_live_customer_recurring_subscription();

COMMENT ON COLUMN plans.is_addon IS 'Independent optional product. Add-ons do not replace the customer primary entitlement.';
COMMENT ON VIEW effective_customer_addons IS 'All currently-effective add-on subscriptions, separate from the single primary customer entitlement.';

COMMIT;
