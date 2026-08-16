BEGIN;

-- A customer may have one primary access contract plus independently billed
-- add-ons. Add-ons must never win the "current entitlement" ranking used by
-- Jellyfin provisioning, reseller capacity, or the main customer dashboard.
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
    s.plan_name_snapshot,
    s.plan_code_snapshot,
    s.price_minor_snapshot,
    s.currency_snapshot,
    s.billing_interval_snapshot,
    s.duration_days_snapshot,
    s.provider_price_id_snapshot,
    p.code,
    p.name,
    p.audience,
    p.billing_interval,
    p.duration_days,
    p.price_minor,
    p.currency,
    p.streams,
    p.allow_downloads,
    p.allow_video_transcoding,
    p.allow_audio_transcoding,
    p.allow_live_tv,
    p.allow_live_tv_management,
    p.server_class,
    p.request_movie_quota_limit,
    p.request_movie_quota_days,
    p.request_tv_quota_limit,
    p.request_tv_quota_days,
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
-- Consumers decide which service type they need; this is intentionally not
-- DISTINCT ON(customer_id).
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
    s.plan_name_snapshot,
    s.plan_code_snapshot,
    s.price_minor_snapshot,
    s.currency_snapshot,
    s.billing_interval_snapshot,
    s.duration_days_snapshot,
    s.provider_price_id_snapshot,
    s.service_type_snapshot,
    p.code,
    p.name,
    p.audience,
    p.billing_interval,
    p.duration_days,
    p.price_minor,
    p.currency,
    p.streams,
    p.service_type,
    p.allow_downloads,
    p.allow_video_transcoding,
    p.allow_audio_transcoding,
    p.allow_live_tv,
    p.allow_live_tv_management,
    p.server_class,
    p.request_movie_quota_limit,
    p.request_movie_quota_days,
    p.request_tv_quota_limit,
    p.request_tv_quota_days,
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
