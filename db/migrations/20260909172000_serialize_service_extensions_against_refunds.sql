BEGIN;

-- Bulk/manual service extensions and confirmed-refund termination both mutate
-- the same subscription ledger row. Serialize extension-event creation on that
-- row so an extension cannot be recorded after the refund boundary was already
-- committed. If the extension wins the row lock first, a later refund still
-- clears the extension through subscriptions_money_loss_terminal; if the refund
-- wins first, this trigger rejects the extension event and the caller's whole
-- transaction rolls back.
CREATE OR REPLACE FUNCTION public.guard_service_extension_against_refund()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    terminal_at timestamptz;
BEGIN
    SELECT s.refund_terminated_at
      INTO terminal_at
      FROM public.subscriptions s
     WHERE s.id=NEW.subscription_id
     FOR UPDATE;

    IF NOT FOUND THEN
        -- Preserve the normal foreign-key failure rather than manufacturing a
        -- misleading refund-boundary error for a missing subscription.
        RETURN NEW;
    END IF;

    IF terminal_at IS NOT NULL THEN
        RAISE EXCEPTION 'Cannot extend a subscription after confirmed refund or lost chargeback.'
            USING ERRCODE='23514',
                  CONSTRAINT='subscription_service_extension_events_refund_terminal',
                  DETAIL='subscription_id='||NEW.subscription_id::text;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subscription_service_extension_events_refund_terminal
ON public.subscription_service_extension_events;

CREATE TRIGGER subscription_service_extension_events_refund_terminal
BEFORE INSERT OR UPDATE OF subscription_id
ON public.subscription_service_extension_events
FOR EACH ROW
EXECUTE FUNCTION public.guard_service_extension_against_refund();

COMMIT;
