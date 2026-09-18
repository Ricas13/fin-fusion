BEGIN;

-- Recurring provider contracts must carry the provider resource family that
-- billing/reconciliation can actually operate on. NOT VALID preserves any
-- historical malformed rows for operator repair while PostgreSQL immediately
-- rejects new or changed invalid recurring identities.
ALTER TABLE public.subscriptions
    DROP CONSTRAINT IF EXISTS subscriptions_recurring_provider_identity_check;

ALTER TABLE public.subscriptions
    ADD CONSTRAINT subscriptions_recurring_provider_identity_check
    CHECK (
        billing_mode <> 'subscription'
        OR source NOT IN ('stripe','paypal')
        OR status NOT IN ('active','trialing','past_due','paused')
        OR (
            source='stripe'
            AND BTRIM(COALESCE(provider_subscription_id,'')) ~* '^sub_'
        )
        OR (
            source='paypal'
            AND BTRIM(COALESCE(provider_subscription_id,'')) ~* '^I-'
        )
    )
    NOT VALID;

-- A provider payment/subscription resource must fund at most one local
-- subscription. Serialize by provider identity so browser-return and webhook
-- races for different local rows cannot both pass an MVCC "not exists" check.
CREATE OR REPLACE FUNCTION public.guard_subscription_provider_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $guard$
DECLARE
    provider_key text;
BEGIN
    IF NEW.source NOT IN ('stripe','paypal','plisio')
       OR NULLIF(BTRIM(COALESCE(NEW.provider_subscription_id,'')),'') IS NULL THEN
        RETURN NEW;
    END IF;

    provider_key := LOWER(BTRIM(NEW.source)) || ':' || BTRIM(NEW.provider_subscription_id);
    PERFORM pg_advisory_xact_lock(hashtextextended('captainfin:subscription-provider:' || provider_key, 0));

    IF EXISTS (
        SELECT 1
        FROM public.subscriptions s
        WHERE s.source=NEW.source
          AND s.provider_subscription_id=NEW.provider_subscription_id
          AND s.id IS DISTINCT FROM NEW.id
    ) THEN
        RAISE EXCEPTION 'Provider billing identity % is already attached to another subscription', provider_key;
    END IF;
    RETURN NEW;
END;
$guard$;

DROP TRIGGER IF EXISTS subscriptions_provider_identity_guard ON public.subscriptions;
CREATE TRIGGER subscriptions_provider_identity_guard
BEFORE INSERT OR UPDATE OF source,provider_subscription_id
ON public.subscriptions
FOR EACH ROW
EXECUTE FUNCTION public.guard_subscription_provider_identity();

COMMIT;
