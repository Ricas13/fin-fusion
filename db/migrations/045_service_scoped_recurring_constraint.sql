BEGIN;

-- The original recurring-subscription trigger enforced one provider-managed
-- primary subscription per customer across the whole account. Jellyfin and
-- Stremio are independent primary service lanes, so uniqueness must only apply
-- when two primary subscriptions overlap the same service. Bundles overlap both
-- lanes. Add-ons retain the existing one-recurring-subscription-per-plan rule.
CREATE OR REPLACE FUNCTION public.enforce_single_live_customer_recurring_subscription() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    new_is_addon BOOLEAN := FALSE;
    new_service TEXT := 'jellyfin';
BEGIN
    IF NEW.superseded_by IS NULL
       AND NEW.source IN ('stripe','paypal')
       AND NEW.status IN ('active','trialing','past_due','paused')
       AND NEW.current_period_end > NOW()
       AND ((NEW.source='stripe' AND LEFT(COALESCE(NEW.provider_subscription_id,''),4)='sub_')
         OR (NEW.source='paypal' AND LEFT(COALESCE(NEW.provider_subscription_id,''),2)='I-')) THEN

        SELECT COALESCE(p.is_addon,FALSE),
               COALESCE(NULLIF(NEW.service_type_snapshot,''),NULLIF(p.service_type,''),'jellyfin')
          INTO new_is_addon,new_service
          FROM plans p
         WHERE p.id=NEW.plan_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Plan not found';
        END IF;

        IF new_is_addon THEN
            IF EXISTS (
                SELECT 1
                  FROM subscriptions s
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
            SELECT 1
              FROM subscriptions s
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
               AND (
                   new_service='bundle'
                   OR COALESCE(NULLIF(s.service_type_snapshot,''),NULLIF(existing_plan.service_type,''),'jellyfin')='bundle'
                   OR COALESCE(NULLIF(s.service_type_snapshot,''),NULLIF(existing_plan.service_type,''),'jellyfin')=new_service
               )
        ) THEN
            RAISE EXCEPTION 'Customer already has a live recurring subscription for an overlapping service';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

COMMIT;
