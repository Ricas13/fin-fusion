BEGIN;

-- Revenue/customer integrity alerts are operationally critical. Enable every
-- configured admin channel by default so automation failures are not discoverable
-- only through a customer complaint.
INSERT INTO notification_preferences(
    event_type,
    telegram_enabled,
    email_enabled,
    discord_enabled,
    event_scope,
    customer_opt_in_allowed,
    display_name,
    description
) VALUES (
    'automation.integrity.failed',
    TRUE,
    TRUE,
    TRUE,
    'admin',
    FALSE,
    'Customer / revenue integrity failure',
    'CAPTaINFiN detected a durable mismatch that can strand a customer, retain unpaid access, lose capacity, or leave a payment/deletion operation requiring intervention.'
)
ON CONFLICT(event_type) DO UPDATE SET
    telegram_enabled=TRUE,
    email_enabled=TRUE,
    discord_enabled=TRUE,
    event_scope='admin',
    customer_opt_in_allowed=FALSE,
    display_name=EXCLUDED.display_name,
    description=EXCLUDED.description,
    updated_at=NOW();

-- The historical portable configuration format did not carry is_free_tier.
-- Normalize the one unambiguous legacy shape before enforcing the pool guard:
-- a zero-price, non-trial, non-add-on plan assigned to server_class=free is the
-- canonical Free Server plan. This keeps old exports/imports safe without ever
-- allowing a paid or trial plan to enter that pool.
CREATE OR REPLACE FUNCTION public.normalize_free_server_plan_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF COALESCE(NEW.server_class,'premium')='free'
       AND COALESCE(NEW.price_minor,0)=0
       AND COALESCE(NEW.billing_interval,'')<>'trial'
       AND COALESCE(NEW.is_addon,FALSE)=FALSE THEN
        NEW.is_free_tier=TRUE;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS normalize_free_server_plan_identity_before_write ON public.plans;
CREATE TRIGGER normalize_free_server_plan_identity_before_write
BEFORE INSERT OR UPDATE OF server_class,price_minor,billing_interval,is_addon,is_free_tier
ON public.plans
FOR EACH ROW
EXECUTE FUNCTION public.normalize_free_server_plan_identity();

UPDATE public.plans
SET is_free_tier=TRUE,updated_at=NOW()
WHERE COALESCE(server_class,'premium')='free'
  AND COALESCE(price_minor,0)=0
  AND COALESCE(billing_interval,'')<>'trial'
  AND COALESCE(is_addon,FALSE)=FALSE
  AND COALESCE(is_free_tier,FALSE)=FALSE;

-- A paid/trial plan must never silently share the canonical Free Server pool.
-- NOT VALID deliberately allows deployment when an old contaminated paid row
-- already exists; the integrity watchdog will flag it. PostgreSQL still enforces
-- this constraint for every newly inserted or updated row immediately.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname='plans_free_server_class_requires_free_tier'
          AND conrelid='plans'::regclass
    ) THEN
        ALTER TABLE plans
            ADD CONSTRAINT plans_free_server_class_requires_free_tier
            CHECK (COALESCE(server_class,'premium') <> 'free' OR COALESCE(is_free_tier,FALSE)=TRUE)
            NOT VALID;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS provider_operations_manual_review_attention_idx
    ON provider_operations(updated_at)
    WHERE manual_review_required=TRUE;

CREATE INDEX IF NOT EXISTS customer_deletion_jobs_attention_idx
    ON customer_deletion_jobs(updated_at)
    WHERE status IN ('failed','running');

CREATE INDEX IF NOT EXISTS payment_events_unprocessed_age_idx
    ON payment_events(created_at)
    WHERE processed_at IS NULL;

COMMIT;
