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

COMMIT;
