BEGIN;

-- The future-prepaid refund reconciler deliberately marks a fully-refunded
-- queued term expired before compacting later prepaid access. The stronger
-- money-loss boundary added by 20260909140000 must keep that explicit terminal
-- state instead of rewriting it to cancelled. Both states are non-live; the
-- distinction matters to the prepaid queue state machine and its audit/tests.
CREATE OR REPLACE FUNCTION public.enforce_subscription_money_loss_terminal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    loss_at timestamptz;
BEGIN
    IF NEW.source IN ('stripe','paypal','plisio')
       AND NULLIF(BTRIM(COALESCE(NEW.provider_subscription_id,'')),'') IS NOT NULL THEN
        SELECT pi.created_at
          INTO loss_at
          FROM public.payment_incidents pi
         WHERE pi.provider=NEW.source
           AND pi.provider_subscription_id=NEW.provider_subscription_id
           AND (
               (pi.incident_type='chargeback' AND pi.incident_status='lost')
               OR (
                   pi.incident_type='refund'
                   AND COALESCE(pi.metadata->>'fullRefund','false')='true'
                   AND (
                       COALESCE(NEW.billing_mode,'payment')<>'subscription'
                       OR COALESCE(pi.metadata->>'currentTermLoss','false')='true'
                   )
               )
           )
         ORDER BY pi.created_at DESC,pi.id DESC
         LIMIT 1;
    END IF;

    IF (TG_OP='UPDATE' AND OLD.refund_terminated_at IS NOT NULL)
       OR NEW.refund_terminated_at IS NOT NULL
       OR loss_at IS NOT NULL THEN
        NEW.refund_terminated_at := COALESCE(
            CASE WHEN TG_OP='UPDATE' THEN OLD.refund_terminated_at ELSE NULL END,
            NEW.refund_terminated_at,
            loss_at,
            NOW()
        );
        NEW.status := CASE WHEN NEW.status='expired' THEN 'expired' ELSE 'cancelled' END;
        NEW.current_period_end := LEAST(COALESCE(NEW.current_period_end,NOW()),NOW());
        NEW.service_extension_days := 0;
        NEW.cancel_at_period_end := TRUE;
    END IF;

    RETURN NEW;
END;
$$;

COMMIT;
