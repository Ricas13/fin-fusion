-- Canonical Free Access is non-expiring at the entitlement layer.
-- Playback-driven Free Server inactivity/removal remains a separate policy.

CREATE OR REPLACE FUNCTION enforce_free_tier_non_expiring_subscription() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    free_tier BOOLEAN := FALSE;
BEGIN
    SELECT COALESCE(is_free_tier,FALSE) INTO free_tier FROM plans WHERE id=NEW.plan_id;
    IF free_tier=TRUE
       AND NEW.superseded_by IS NULL
       AND NEW.status IN ('active','trialing','past_due','paused') THEN
        NEW.current_period_end := '9999-12-31 23:59:59+00'::timestamptz;
        NEW.service_extension_days := 0;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subscriptions_free_tier_non_expiring ON subscriptions;
CREATE TRIGGER subscriptions_free_tier_non_expiring
BEFORE INSERT OR UPDATE OF plan_id,current_period_end,service_extension_days ON subscriptions
FOR EACH ROW EXECUTE FUNCTION enforce_free_tier_non_expiring_subscription();

UPDATE subscriptions s
SET current_period_end='9999-12-31 23:59:59+00'::timestamptz,
    service_extension_days=0,
    updated_at=NOW()
FROM plans p
WHERE p.id=s.plan_id
  AND p.is_free_tier=TRUE
  AND s.superseded_by IS NULL
  AND s.status IN ('active','trialing','past_due','paused')
  AND (s.current_period_end<'9999-01-01 00:00:00+00'::timestamptz OR s.service_extension_days<>0);
