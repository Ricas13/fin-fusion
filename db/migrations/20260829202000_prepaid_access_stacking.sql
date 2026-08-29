-- Stack new one-time paid access after existing overlapping prepaid access.
-- Recurring provider agreements remain provider-authoritative and are never shifted.

CREATE OR REPLACE FUNCTION stack_prepaid_subscription_window()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_service text;
  target_is_addon boolean;
  stack_end timestamptz;
  interval_name text;
  duration_days integer;
BEGIN
  IF NEW.source NOT IN ('stripe','paypal','plisio') THEN
    RETURN NEW;
  END IF;

  -- Stripe subscriptions use sub_* and PayPal subscriptions use I-*.
  -- Those recurring agreements must keep their provider-supplied period boundaries.
  IF (NEW.source='stripe' AND COALESCE(NEW.provider_subscription_id,'') ~* '^sub_')
     OR (NEW.source='paypal' AND COALESCE(NEW.provider_subscription_id,'') ~* '^I-') THEN
    RETURN NEW;
  END IF;

  IF NEW.status NOT IN ('active','trialing') THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(service_type,'jellyfin'),COALESCE(is_addon,FALSE)
    INTO target_service,target_is_addon
    FROM plans
   WHERE id=NEW.plan_id;

  IF target_is_addon THEN
    RETURN NEW;
  END IF;

  -- Keep stacking safe even if two provider completions arrive together.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.customer_id::text,0));

  SELECT MAX(s.current_period_end)
    INTO stack_end
    FROM subscriptions s
    JOIN plans p ON p.id=s.plan_id
   WHERE s.customer_id=NEW.customer_id
     AND s.superseded_by IS NULL
     AND COALESCE(p.is_addon,FALSE)=FALSE
     AND s.status IN ('active','trialing','past_due','paused')
     AND s.current_period_end>NOW()
     AND s.source IN ('stripe','paypal','plisio')
     AND NOT (s.source='stripe' AND COALESCE(s.provider_subscription_id,'') ~* '^sub_')
     AND NOT (s.source='paypal' AND COALESCE(s.provider_subscription_id,'') ~* '^I-')
     AND (
       COALESCE(s.service_type_snapshot,p.service_type,'jellyfin')='bundle'
       OR target_service='bundle'
       OR COALESCE(s.service_type_snapshot,p.service_type,'jellyfin')=target_service
     );

  IF stack_end IS NULL OR stack_end<=NOW() THEN
    RETURN NEW;
  END IF;

  interval_name:=LOWER(COALESCE(NEW.billing_interval_snapshot,(NEW.commercial_snapshot->>'billingInterval'),''));
  duration_days:=COALESCE(NEW.duration_days_snapshot,NULLIF((NEW.commercial_snapshot->>'durationDays')::integer,0),30);

  NEW.starts_at:=stack_end;
  NEW.current_period_end:=CASE interval_name
    WHEN 'month' THEN stack_end + INTERVAL '1 month'
    WHEN '6_months' THEN stack_end + INTERVAL '6 months'
    WHEN 'year' THEN stack_end + INTERVAL '1 year'
    ELSE stack_end + (GREATEST(1,duration_days)::text || ' days')::interval
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stack_prepaid_subscription_window ON subscriptions;
CREATE TRIGGER trg_stack_prepaid_subscription_window
BEFORE INSERT ON subscriptions
FOR EACH ROW
EXECUTE FUNCTION stack_prepaid_subscription_window();
