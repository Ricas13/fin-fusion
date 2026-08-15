BEGIN;

CREATE TABLE IF NOT EXISTS referral_service_credits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    source_redemption_id UUID REFERENCES referral_redemptions(id) ON DELETE SET NULL,
    plan_id UUID REFERENCES plans(id) ON DELETE SET NULL,
    days_total INTEGER NOT NULL CHECK (days_total > 0 AND days_total <= 3650),
    days_consumed INTEGER NOT NULL DEFAULT 0 CHECK (days_consumed >= 0),
    state TEXT NOT NULL DEFAULT 'banked' CHECK (state IN ('banked','applied','cancelled')),
    applied_subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    applied_at TIMESTAMPTZ,
    note TEXT,
    UNIQUE(source_redemption_id)
);
CREATE INDEX IF NOT EXISTS referral_service_credits_customer_state_idx
    ON referral_service_credits(customer_id,state,created_at);

ALTER TABLE plan_provider_prices
    ADD COLUMN IF NOT EXISTS validation_state TEXT NOT NULL DEFAULT 'unverified'
        CHECK (validation_state IN ('unverified','verified','failed')),
    ADD COLUMN IF NOT EXISTS validated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS validation_error TEXT,
    ADD COLUMN IF NOT EXISTS validated_external_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE reseller_tiers
    ADD COLUMN IF NOT EXISTS plan_rule_mode TEXT NOT NULL DEFAULT 'allow_all'
        CHECK (plan_rule_mode IN ('allow_all','allowlist'));

COMMIT;
