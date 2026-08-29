BEGIN;

ALTER TABLE provider_operations
    ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_observed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS failure_kind TEXT,
    ADD COLUMN IF NOT EXISTS manual_review_required BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE provider_operations
    DROP CONSTRAINT IF EXISTS provider_operations_failure_kind_check;
ALTER TABLE provider_operations
    ADD CONSTRAINT provider_operations_failure_kind_check
    CHECK (failure_kind IS NULL OR failure_kind IN ('retryable','ambiguous','terminal','superseded'));

CREATE INDEX IF NOT EXISTS provider_operations_recovery_due_idx
    ON provider_operations(next_attempt_at,created_at)
    WHERE state IN ('planned','provider_applied','failed')
      AND manual_review_required=FALSE
      AND COALESCE(failure_kind,'') NOT IN ('terminal','superseded');

-- One row-level lock is the canonical serialization point for commercial
-- subscription activation. It is deliberately customer-scoped rather than
-- provider-scoped so Stripe, PayPal, Plisio, service-credit and admin paths
-- cannot race one another through separate application pre-checks. The
-- existing service-aware recurring trigger remains the second line of defence.
CREATE OR REPLACE FUNCTION public.serialize_customer_commercial_activation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.superseded_by IS NULL
       AND NEW.status IN ('active','trialing','past_due','paused') THEN
        PERFORM 1 FROM public.customers WHERE id=NEW.customer_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Customer not found for subscription activation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS aa_serialize_customer_commercial_activation ON public.subscriptions;
CREATE TRIGGER aa_serialize_customer_commercial_activation
BEFORE INSERT OR UPDATE OF customer_id,plan_id,status,source,current_period_end,superseded_by
ON public.subscriptions
FOR EACH ROW
EXECUTE FUNCTION public.serialize_customer_commercial_activation();

COMMIT;
