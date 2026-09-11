BEGIN;

-- Confirmed money loss stays terminal, except for the narrow case where the
-- same provider dispute/chargeback case was later won by the merchant and that
-- winning case has been re-verified against the exact local subscription.
-- Full refunds are never reversible through this path.
CREATE OR REPLACE FUNCTION public.enforce_subscription_money_loss_terminal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    loss_at timestamptz;
    reversible_chargeback boolean := false;
BEGIN
    IF NEW.source IN ('stripe','paypal','plisio')
       AND NULLIF(BTRIM(COALESCE(NEW.provider_subscription_id,'')),'') IS NOT NULL THEN
        SELECT pi.created_at
          INTO loss_at
          FROM public.payment_incidents pi
         WHERE pi.provider=NEW.source
           AND pi.provider_subscription_id=NEW.provider_subscription_id
           AND (
               (
                   pi.incident_type='chargeback'
                   AND pi.incident_status='lost'
                   AND NOT EXISTS (
                       SELECT 1
                         FROM public.payment_incidents won
                        WHERE won.provider=pi.provider
                          AND won.provider_case_id=pi.provider_case_id
                          AND won.provider_subscription_id=pi.provider_subscription_id
                          AND won.incident_status='won'
                          AND won.created_at>=pi.created_at
                          AND won.customer_id IS NOT DISTINCT FROM pi.customer_id
                          AND COALESCE((won.metadata->'providerReconciliation'->>'restoreEligible')::boolean,FALSE)=TRUE
                          AND won.metadata->'providerReconciliation'->>'matchedSubscriptionId'=NEW.id::text
                   )
               )
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

        SELECT EXISTS (
            SELECT 1
              FROM public.payment_incidents lost
              JOIN public.payment_incidents won
                ON won.provider=lost.provider
               AND won.provider_case_id=lost.provider_case_id
               AND won.provider_subscription_id=lost.provider_subscription_id
               AND won.customer_id IS NOT DISTINCT FROM lost.customer_id
               AND won.incident_status='won'
               AND won.created_at>=lost.created_at
             WHERE lost.provider=NEW.source
               AND lost.provider_subscription_id=NEW.provider_subscription_id
               AND lost.incident_type='chargeback'
               AND lost.incident_status='lost'
               AND COALESCE((won.metadata->'providerReconciliation'->>'restoreEligible')::boolean,FALSE)=TRUE
               AND won.metadata->'providerReconciliation'->>'matchedSubscriptionId'=NEW.id::text
        ) INTO reversible_chargeback;
    END IF;

    -- refund_terminated_at is sticky by default. Clearing it is allowed only
    -- through an explicit UPDATE after exact winning-case reconciliation and
    -- only when no other terminal loss still applies to this settlement.
    IF TG_OP='UPDATE' AND OLD.refund_terminated_at IS NOT NULL THEN
        IF NEW.refund_terminated_at IS NULL
           AND reversible_chargeback
           AND loss_at IS NULL THEN
            RETURN NEW;
        END IF;
        NEW.refund_terminated_at := OLD.refund_terminated_at;
        NEW.status := CASE WHEN NEW.status='expired' THEN 'expired' ELSE 'cancelled' END;
        NEW.current_period_end := LEAST(COALESCE(NEW.current_period_end,NOW()),NOW());
        NEW.service_extension_days := 0;
        NEW.cancel_at_period_end := TRUE;
        RETURN NEW;
    END IF;

    IF NEW.refund_terminated_at IS NOT NULL OR loss_at IS NOT NULL THEN
        NEW.refund_terminated_at := COALESCE(NEW.refund_terminated_at,loss_at,NOW());
        NEW.status := CASE WHEN NEW.status='expired' THEN 'expired' ELSE 'cancelled' END;
        NEW.current_period_end := LEAST(COALESCE(NEW.current_period_end,NOW()),NOW());
        NEW.service_extension_days := 0;
        NEW.cancel_at_period_end := TRUE;
    END IF;

    RETURN NEW;
END;
$$;

COMMIT;
