BEGIN;

-- Stripe resource families are semantically distinct. A pi_* identifier is a
-- PaymentIntent and can never be used with the Stripe Subscriptions API. Keep
-- billing_mode authoritative in general, but make this impossible tuple
-- self-healing at the database boundary so historical metadata cannot route a
-- one-off payment into renewal automation again.
CREATE OR REPLACE FUNCTION public.normalize_subscription_billing_mode()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    snapshot_mode text;
BEGIN
    snapshot_mode := lower(COALESCE(NEW.commercial_snapshot->>'checkoutMode',''));

    IF NEW.source = 'stripe'
       AND COALESCE(NEW.provider_subscription_id,'') ~* '^pi_' THEN
        NEW.billing_mode := 'payment';
    ELSIF NEW.source IN ('stripe','paypal','plisio') THEN
        IF snapshot_mode IN ('subscription','payment') THEN
            NEW.billing_mode := snapshot_mode;
        ELSIF NEW.billing_mode IS NULL THEN
            IF TG_OP = 'UPDATE' AND OLD.billing_mode IS NOT NULL THEN
                NEW.billing_mode := OLD.billing_mode;
            ELSE
                NEW.billing_mode := 'payment';
            END IF;
        END IF;
    ELSIF NEW.billing_mode IS NULL THEN
        NEW.billing_mode := 'manual';
    END IF;

    IF NEW.billing_mode NOT IN ('subscription','payment','manual') THEN
        RAISE EXCEPTION 'Invalid subscription billing mode: %', NEW.billing_mode;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subscriptions_billing_mode_normalize ON public.subscriptions;
CREATE TRIGGER subscriptions_billing_mode_normalize
BEFORE INSERT OR UPDATE OF source,commercial_snapshot,billing_mode,provider_subscription_id
ON public.subscriptions
FOR EACH ROW
EXECUTE FUNCTION public.normalize_subscription_billing_mode();

-- Repair rows created before the resource-family invariant existed. The trigger
-- above runs on this update and intentionally preserves payment mode for pi_*.
UPDATE public.subscriptions
SET billing_mode='payment',updated_at=NOW()
WHERE source='stripe'
  AND billing_mode='subscription'
  AND COALESCE(provider_subscription_id,'') ~* '^pi_';

-- Renewal operations against those rows are not unresolved provider work: they
-- were impossible operations generated from the bad classification. Retire
-- them as superseded rather than leaving permanent manual-review alerts.
UPDATE public.provider_operations po
SET state='failed',
    last_error='Superseded by payment-integrity repair: Stripe PaymentIntent is a one-off payment and cannot be used for subscription renewal.',
    failure_kind='superseded',
    manual_review_required=FALSE,
    next_attempt_at=NULL,
    provider_result=COALESCE(po.provider_result,'{}'::jsonb)
        || jsonb_build_object('integrityRepair','stripe_payment_intent_billing_mode'),
    updated_at=NOW()
FROM public.subscriptions s
WHERE po.provider='stripe'
  AND po.operation_type IN ('renewal_stop','renewal_resume')
  AND po.local_reference=s.id::text
  AND s.source='stripe'
  AND s.billing_mode='payment'
  AND COALESCE(s.provider_subscription_id,'') ~* '^pi_'
  AND COALESCE(po.request_snapshot->>'providerSubscriptionId','')=s.provider_subscription_id
  AND po.state IN ('planned','provider_applied','local_applied','failed')
  AND COALESCE(po.failure_kind,'')<>'superseded';

ALTER TABLE public.subscriptions
    DROP CONSTRAINT IF EXISTS subscriptions_stripe_recurring_provider_id_check;
ALTER TABLE public.subscriptions
    ADD CONSTRAINT subscriptions_stripe_recurring_provider_id_check
    CHECK (
        NOT (
            source='stripe'
            AND billing_mode='subscription'
            AND COALESCE(provider_subscription_id,'') ~* '^pi_'
        )
    );

COMMIT;
