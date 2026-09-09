BEGIN;

-- Refund/chargeback termination is a permanent boundary for the paid term.
-- Keep that boundary on the subscription row so any future writer (bulk tools,
-- admin UI, migrations, or a new service) cannot accidentally resurrect the
-- term by adding service-extension days after money was confirmed lost.
ALTER TABLE public.subscriptions
    ADD COLUMN IF NOT EXISTS refund_terminated_at timestamptz;

WITH terminated AS (
    SELECT a.entity_id::uuid AS subscription_id,
           MAX(a.created_at) AS terminated_at
    FROM public.audit_log a
    WHERE a.action='billing.subscription.terminate_for_refund'
      AND a.entity_type='subscription'
      AND a.entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    GROUP BY a.entity_id::uuid
)
UPDATE public.subscriptions s
SET refund_terminated_at=t.terminated_at,
    service_extension_days=0,
    updated_at=NOW()
FROM terminated t
WHERE s.id=t.subscription_id
  AND (s.refund_terminated_at IS NULL OR s.service_extension_days<>0);

ALTER TABLE public.subscriptions
    DROP CONSTRAINT IF EXISTS subscriptions_refund_terminated_no_extension_check;

ALTER TABLE public.subscriptions
    ADD CONSTRAINT subscriptions_refund_terminated_no_extension_check
    CHECK (refund_terminated_at IS NULL OR COALESCE(service_extension_days,0)=0);

CREATE OR REPLACE FUNCTION public.mark_subscription_refund_terminated()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.action='billing.subscription.terminate_for_refund'
       AND NEW.entity_type='subscription'
       AND NEW.entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        UPDATE public.subscriptions
        SET refund_terminated_at=COALESCE(refund_terminated_at,NEW.created_at,NOW()),
            service_extension_days=0,
            updated_at=NOW()
        WHERE id=NEW.entity_id::uuid;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_subscription_refund_terminated() FROM PUBLIC;

DROP TRIGGER IF EXISTS audit_log_mark_refund_terminated_subscription ON public.audit_log;
CREATE TRIGGER audit_log_mark_refund_terminated_subscription
AFTER INSERT ON public.audit_log
FOR EACH ROW
WHEN (NEW.action='billing.subscription.terminate_for_refund' AND NEW.entity_type='subscription')
EXECUTE FUNCTION public.mark_subscription_refund_terminated();

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.subscriptions
        WHERE refund_terminated_at IS NOT NULL
          AND COALESCE(service_extension_days,0)<>0
    ) THEN
        RAISE EXCEPTION 'refund-terminated subscriptions must not retain service extensions';
    END IF;
END;
$$;

COMMIT;
