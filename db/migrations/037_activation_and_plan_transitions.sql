BEGIN;

CREATE TABLE IF NOT EXISTS account_activation_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    token_encrypted TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('customer_activation','reseller_activation')),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS account_activation_tokens_one_active
    ON account_activation_tokens(user_id,purpose)
    WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS account_activation_tokens_expiry_idx ON account_activation_tokens(expires_at);

ALTER TABLE reseller_subscriptions
    ADD COLUMN IF NOT EXISTS pending_tier_id UUID REFERENCES reseller_tiers(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS pending_tier_effective_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS pending_tier_requested_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS customer_plan_changes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    current_subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
    target_plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
    provider TEXT CHECK (provider IS NULL OR provider IN ('stripe','paypal','manual')),
    mode TEXT NOT NULL DEFAULT 'period_end' CHECK (mode IN ('immediate','period_end')),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','applied','cancelled','failed')),
    effective_at TIMESTAMPTZ,
    requested_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_plan_changes_one_pending
    ON customer_plan_changes(customer_id) WHERE state='pending';

INSERT INTO platform_settings(setting_key,setting_value)
VALUES ('trial_free_policy',jsonb_build_object(
    'trialMode','once_ever',
    'freeMode','once_per_plan',
    'paidCanClaimFree',false,
    'downgradeToFree',false
)) ON CONFLICT(setting_key) DO NOTHING;

COMMIT;
