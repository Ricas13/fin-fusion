BEGIN;

-- Keep the database downgrade ceiling identical to src/resellers/monthly.js:
-- one reseller-assigned customer with any live, started, unsuperseded
-- entitlement consumes one commercial seat. The earlier guard only counted
-- reseller_sale rows through the one-row-per-customer entitlement view, which
-- could miss a customer whose longer direct entitlement won that view.
CREATE OR REPLACE FUNCTION enforce_pending_reseller_tier_capacity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    reseller_uuid UUID;
    target_limit INTEGER;
    used_count INTEGER;
    contributes BOOLEAN;
BEGIN
    IF NEW.superseded_by IS NOT NULL THEN
        RETURN NEW;
    END IF;

    contributes := NEW.starts_at <= NOW()
        AND (
            (NEW.status IN ('active','trialing','past_due','paused') AND NEW.current_period_end > NOW())
            OR (
                COALESCE(NEW.service_extension_days,0) > 0
                AND NEW.status IN ('active','trialing','past_due','paused','cancelled','expired')
                AND NEW.current_period_end + (NEW.service_extension_days||' days')::interval > NOW()
            )
        );
    IF NOT contributes THEN RETURN NEW; END IF;

    SELECT c.reseller_id INTO reseller_uuid
    FROM customers c
    WHERE c.id=NEW.customer_id;
    IF reseller_uuid IS NULL THEN RETURN NEW; END IF;

    SELECT rt.seat_limit INTO target_limit
    FROM reseller_subscriptions rs
    JOIN reseller_tiers rt ON rt.id=rs.pending_tier_id
    WHERE rs.reseller_id=reseller_uuid
      AND rs.pending_tier_id IS NOT NULL
      AND rs.status IN ('active','past_due')
      AND rs.current_period_end>NOW()
    ORDER BY rs.current_period_end DESC,rs.created_at DESC
    LIMIT 1;
    IF target_limit IS NULL THEN RETURN NEW; END IF;

    SELECT COUNT(DISTINCT c.id)::int INTO used_count
    FROM customers c
    WHERE c.reseller_id=reseller_uuid
      AND c.id<>NEW.customer_id
      AND EXISTS (
          SELECT 1
          FROM subscriptions s
          WHERE s.customer_id=c.id
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
      );

    IF COALESCE(used_count,0)+1 > target_limit THEN
        RAISE EXCEPTION 'Pending reseller tier change limits this estate to % active seats', target_limit;
    END IF;
    RETURN NEW;
END;
$$;

-- Recreate explicitly so source changes are also covered. The function itself
-- decides whether the new row contributes a live seat.
DROP TRIGGER IF EXISTS pending_reseller_tier_capacity_trigger ON subscriptions;
CREATE TRIGGER pending_reseller_tier_capacity_trigger
BEFORE INSERT OR UPDATE OF customer_id,status,source,starts_at,current_period_end,service_extension_days,superseded_by
ON subscriptions FOR EACH ROW EXECUTE FUNCTION enforce_pending_reseller_tier_capacity();

COMMIT;
