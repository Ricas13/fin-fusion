BEGIN;

-- Keep historical malformed rows writable for status cancellation and repair.
-- A NOT VALID CHECK still runs on every UPDATE of old rows, so it would make
-- live webhook/reconciliation updates fail for precisely the legacy records
-- that need operator attention. Enforce new or newly-activated identities in
-- a trigger instead; the integrity watchdog continues to report old defects.
ALTER TABLE public.subscriptions
    DROP CONSTRAINT IF EXISTS subscriptions_recurring_provider_identity_check;

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
    IF NEW.billing_mode='subscription'
       AND NEW.source IN ('stripe','paypal')
       AND NEW.status IN ('active','trialing','past_due','paused')
       AND (
           (NEW.source='stripe' AND (
               NEW.provider_subscription_id IS DISTINCT FROM BTRIM(NEW.provider_subscription_id)
               OR BTRIM(COALESCE(NEW.provider_subscription_id,'')) !~* '^sub_'
           ))
           OR (NEW.source='paypal' AND (
               NEW.provider_subscription_id IS DISTINCT FROM BTRIM(NEW.provider_subscription_id)
               OR BTRIM(COALESCE(NEW.provider_subscription_id,'')) !~* '^I-'
           ))
       )
       AND (
           TG_OP='INSERT'
           OR NEW.source IS DISTINCT FROM OLD.source
           OR NEW.provider_subscription_id IS DISTINCT FROM OLD.provider_subscription_id
           OR NEW.billing_mode IS DISTINCT FROM OLD.billing_mode
           OR OLD.status NOT IN ('active','trialing','past_due','paused')
           OR (
               NEW.status IN ('active','trialing')
               AND NEW.status IS DISTINCT FROM OLD.status
           )
       ) THEN
        RAISE EXCEPTION 'Invalid recurring provider billing identity for %: %', NEW.source, NEW.provider_subscription_id;
    END IF;

    IF NEW.source NOT IN ('stripe','paypal','plisio')
       OR NULLIF(BTRIM(COALESCE(NEW.provider_subscription_id,'')),'') IS NULL THEN
        RETURN NEW;
    END IF;

    -- Historical duplicate provider identities are surfaced by the integrity
    -- watchdog, but routine status/billing updates on those legacy rows must
    -- remain possible so failed-payment and cancellation reconciliation cannot
    -- be blocked by the guard itself. Re-check single ownership when an identity
    -- is first attached/changed or a terminal/non-recurring row re-enters live
    -- recurring ownership.
    IF TG_OP='INSERT'
       OR NEW.source IS DISTINCT FROM OLD.source
       OR NEW.provider_subscription_id IS DISTINCT FROM OLD.provider_subscription_id
       OR (NEW.billing_mode='subscription' AND OLD.billing_mode IS DISTINCT FROM 'subscription')
       OR (
           NEW.status IN ('active','trialing','past_due','paused')
           AND OLD.status NOT IN ('active','trialing','past_due','paused')
       ) THEN
        provider_key := LOWER(BTRIM(NEW.source)) || ':' || BTRIM(NEW.provider_subscription_id);
        PERFORM pg_advisory_xact_lock(hashtextextended('captainfin:subscription-provider:' || provider_key, 0));

        IF EXISTS (
            SELECT 1
            FROM public.subscriptions s
            WHERE LOWER(BTRIM(s.source))=LOWER(BTRIM(NEW.source))
              AND BTRIM(COALESCE(s.provider_subscription_id,''))=BTRIM(NEW.provider_subscription_id)
              AND s.id IS DISTINCT FROM NEW.id
        ) THEN
            RAISE EXCEPTION 'Provider billing identity % is already attached to another subscription', provider_key;
        END IF;
    END IF;
    RETURN NEW;
END;
$guard$;

DROP TRIGGER IF EXISTS subscriptions_provider_identity_guard ON public.subscriptions;
CREATE TRIGGER subscriptions_provider_identity_guard
BEFORE INSERT OR UPDATE OF source,provider_subscription_id,billing_mode,status
ON public.subscriptions
FOR EACH ROW
EXECUTE FUNCTION public.guard_subscription_provider_identity();

COMMIT;
