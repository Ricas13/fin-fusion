BEGIN;

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS billing_mode text;

UPDATE subscriptions
SET billing_mode=CASE
  WHEN lower(COALESCE(commercial_snapshot->>'checkoutMode','')) IN ('subscription','payment')
    THEN lower(commercial_snapshot->>'checkoutMode')
  WHEN source='stripe' AND COALESCE(provider_subscription_id,'') LIKE 'sub\_%' ESCAPE '\'
    THEN 'subscription'
  WHEN source='paypal' AND COALESCE(provider_subscription_id,'') LIKE 'I-%'
    THEN 'subscription'
  WHEN source IN ('stripe','paypal','plisio')
    THEN 'payment'
  ELSE 'manual'
END
WHERE billing_mode IS NULL;

ALTER TABLE subscriptions ALTER COLUMN billing_mode SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='subscriptions_billing_mode_check'
      AND conrelid='subscriptions'::regclass
  ) THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_billing_mode_check
      CHECK (billing_mode IN ('subscription','payment','manual'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION normalize_subscription_billing_mode() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  snapshot_mode text;
BEGIN
  snapshot_mode := lower(COALESCE(NEW.commercial_snapshot->>'checkoutMode',''));

  IF NEW.source IN ('stripe','paypal','plisio') THEN
    IF snapshot_mode IN ('subscription','payment') THEN
      NEW.billing_mode := snapshot_mode;
    ELSIF NEW.billing_mode IS NULL THEN
      IF TG_OP='UPDATE' AND OLD.billing_mode IS NOT NULL THEN
        NEW.billing_mode := OLD.billing_mode;
      ELSE
        NEW.billing_mode := 'payment';
      END IF;
    END IF;
  ELSIF NEW.billing_mode IS NULL THEN
    NEW.billing_mode := 'manual';
  END IF;

  IF NEW.billing_mode NOT IN ('subscription','payment','manual') THEN
    RAISE EXCEPTION 'Unsupported subscription billing mode: %', NEW.billing_mode;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subscriptions_billing_mode_normalize ON subscriptions;
CREATE TRIGGER subscriptions_billing_mode_normalize
BEFORE INSERT OR UPDATE OF source,commercial_snapshot,billing_mode ON subscriptions
FOR EACH ROW EXECUTE FUNCTION normalize_subscription_billing_mode();

-- Preserve the service-scoped invariant from migration 045, but make the
-- local billing contract authoritative. Provider identifier prefixes are only
-- used above for the one-time migration backfill of historical rows.
CREATE OR REPLACE FUNCTION enforce_single_live_customer_recurring_subscription() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    new_is_addon BOOLEAN := FALSE;
    new_service TEXT := 'jellyfin';
BEGIN
    IF NEW.superseded_by IS NULL
       AND NEW.source IN ('stripe','paypal')
       AND NEW.billing_mode='subscription'
       AND NEW.status IN ('active','trialing','past_due','paused')
       AND NEW.current_period_end > NOW() THEN

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
                   AND s.billing_mode='subscription'
                   AND s.status IN ('active','trialing','past_due','paused')
                   AND s.current_period_end>NOW()
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
               AND s.billing_mode='subscription'
               AND s.status IN ('active','trialing','past_due','paused')
               AND s.current_period_end>NOW()
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

CREATE INDEX IF NOT EXISTS subscriptions_live_recurring_customer_idx
  ON subscriptions(customer_id,source,current_period_end)
  WHERE billing_mode='subscription'
    AND superseded_by IS NULL
    AND status IN ('active','trialing','past_due','paused');

COMMIT;
