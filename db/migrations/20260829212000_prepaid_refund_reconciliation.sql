-- Remove fully refunded future prepaid entitlement and close the queue gap.
-- Recurring provider agreements are excluded; active/partially consumed periods are not shortened here.

CREATE OR REPLACE FUNCTION reconcile_future_prepaid_full_refund()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  refunded subscriptions%ROWTYPE;
  refunded_service text;
  removed_span interval;
BEGIN
  IF NEW.incident_type <> 'refund' OR COALESCE((NEW.metadata->>'fullRefund')::boolean,FALSE) IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  IF NEW.provider_subscription_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF (NEW.provider='stripe' AND NEW.provider_subscription_id ~* '^sub_')
     OR (NEW.provider='paypal' AND NEW.provider_subscription_id ~* '^I-') THEN
    RETURN NEW;
  END IF;

  SELECT s.* INTO refunded
  FROM subscriptions s
  WHERE s.source=NEW.provider
    AND s.provider_subscription_id=NEW.provider_subscription_id
    AND s.superseded_by IS NULL
  ORDER BY s.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND OR refunded.starts_at <= NOW() OR refunded.status NOT IN ('active','trialing','past_due','paused','cancelled') THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(s.service_type_snapshot,p.service_type,'jellyfin') INTO refunded_service
  FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.id=refunded.id;
  removed_span:=refunded.current_period_end-refunded.starts_at;

  UPDATE subscriptions
     SET status='expired', service_extension_days=0, updated_at=NOW()
   WHERE id=refunded.id;

  UPDATE subscriptions s
     SET starts_at=s.starts_at-removed_span,
         current_period_end=s.current_period_end-removed_span,
         updated_at=NOW()
    FROM plans p
   WHERE s.plan_id=p.id
     AND s.customer_id=refunded.customer_id
     AND s.id<>refunded.id
     AND s.superseded_by IS NULL
     AND s.starts_at>=refunded.current_period_end
     AND s.status IN ('active','trialing','past_due','paused','cancelled')
     AND s.source IN ('stripe','paypal','plisio')
     AND NOT (s.source='stripe' AND COALESCE(s.provider_subscription_id,'') ~* '^sub_')
     AND NOT (s.source='paypal' AND COALESCE(s.provider_subscription_id,'') ~* '^I-')
     AND (
       COALESCE(s.service_type_snapshot,p.service_type,'jellyfin')='bundle'
       OR refunded_service='bundle'
       OR COALESCE(s.service_type_snapshot,p.service_type,'jellyfin')=refunded_service
     );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reconcile_future_prepaid_full_refund ON payment_incidents;
CREATE TRIGGER trg_reconcile_future_prepaid_full_refund
AFTER INSERT ON payment_incidents
FOR EACH ROW
EXECUTE FUNCTION reconcile_future_prepaid_full_refund();
