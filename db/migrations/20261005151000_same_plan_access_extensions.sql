BEGIN;

-- One-off purchases of a customer's current paid plan extend the existing
-- entitlement instead of creating another service subscription. The payment
-- remains durable and individually reversible without consuming more server
-- capacity or changing the recurring provider agreement.
CREATE TABLE IF NOT EXISTS public.subscription_access_extensions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
    subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
    plan_id uuid NOT NULL REFERENCES public.plans(id),
    provider text NOT NULL CHECK (provider IN ('stripe','paypal','plisio')),
    provider_payment_id text NOT NULL,
    checkout_intent_id uuid REFERENCES public.billing_checkout_intents(id) ON DELETE SET NULL,
    purchased_days integer NOT NULL CHECK (purchased_days > 0 AND purchased_days <= 3650),
    applied_days integer NOT NULL CHECK (applied_days >= 0 AND applied_days <= 3650),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
    commercial_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    revoked_at timestamptz,
    revoke_reason text,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    UNIQUE(provider,provider_payment_id),
    UNIQUE(checkout_intent_id)
);

-- This migration is intentionally repeatable during rolling deploys. If an
-- earlier candidate created the table before applied_days existed, bring that
-- schema forward without losing the historical purchased-day record.
ALTER TABLE public.subscription_access_extensions
    ADD COLUMN IF NOT EXISTS applied_days integer;

UPDATE public.subscription_access_extensions
SET applied_days=CASE WHEN status='active' THEN purchased_days ELSE 0 END
WHERE applied_days IS NULL;

ALTER TABLE public.subscription_access_extensions
    ALTER COLUMN applied_days SET NOT NULL;

DO $
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid='public.subscription_access_extensions'::regclass
          AND conname='subscription_access_extensions_applied_days_check'
    ) THEN
        ALTER TABLE public.subscription_access_extensions
            ADD CONSTRAINT subscription_access_extensions_applied_days_check
            CHECK (applied_days >= 0 AND applied_days <= 3650);
    END IF;
END $;

CREATE INDEX IF NOT EXISTS subscription_access_extensions_subscription_idx
    ON public.subscription_access_extensions(subscription_id,status,created_at);

CREATE INDEX IF NOT EXISTS subscription_access_extensions_customer_idx
    ON public.subscription_access_extensions(customer_id,created_at DESC);

COMMENT ON TABLE public.subscription_access_extensions IS
'Durable one-off purchases that add paid days to an existing subscription without creating another service entitlement or consuming capacity.';

COMMIT;
