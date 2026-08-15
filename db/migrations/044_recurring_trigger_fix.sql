BEGIN;

-- Migration 036 used an ESCAPE literal that PostgreSQL 17 parses as more than
-- one character. Replace the check with regex predicates so the provider-ID
-- classification is explicit and does not depend on LIKE escape semantics.
CREATE OR REPLACE FUNCTION enforce_single_live_customer_recurring_subscription()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.source IN ('stripe','paypal')
       AND NEW.status IN ('active','trialing','past_due','paused')
       AND NEW.current_period_end > NOW()
       AND ((NEW.source='stripe' AND COALESCE(NEW.provider_subscription_id,'') ~ '^sub_')
         OR (NEW.source='paypal' AND COALESCE(NEW.provider_subscription_id,'') ~ '^I-'))
       AND EXISTS (
            SELECT 1 FROM subscriptions s
            WHERE s.customer_id=NEW.customer_id
              AND s.id<>NEW.id
              AND s.superseded_by IS NULL
              AND s.source IN ('stripe','paypal')
              AND s.status IN ('active','trialing','past_due','paused')
              AND s.current_period_end>NOW()
              AND ((s.source='stripe' AND COALESCE(s.provider_subscription_id,'') ~ '^sub_')
                OR (s.source='paypal' AND COALESCE(s.provider_subscription_id,'') ~ '^I-'))
       ) THEN
        RAISE EXCEPTION 'Customer already has a live recurring provider subscription';
    END IF;
    RETURN NEW;
END;
$$;

COMMIT;
