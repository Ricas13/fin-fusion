BEGIN;

CREATE TABLE IF NOT EXISTS discount_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    discount_type TEXT NOT NULL CHECK (discount_type IN ('percent','fixed')),
    percent_off INTEGER CHECK (percent_off IS NULL OR (percent_off > 0 AND percent_off <= 100)),
    fixed_off_minor INTEGER CHECK (fixed_off_minor IS NULL OR fixed_off_minor > 0),
    currency CHAR(3),
    plan_codes TEXT[],
    max_redemptions INTEGER CHECK (max_redemptions IS NULL OR max_redemptions > 0),
    redemption_count INTEGER NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
    per_customer_limit INTEGER NOT NULL DEFAULT 1 CHECK (per_customer_limit > 0),
    starts_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    stripe_coupon_id TEXT,
    created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (discount_type = 'percent' AND percent_off IS NOT NULL AND fixed_off_minor IS NULL)
        OR
        (discount_type = 'fixed' AND fixed_off_minor IS NOT NULL AND percent_off IS NULL)
    )
);

CREATE TABLE IF NOT EXISTS discount_redemptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    discount_code_id UUID NOT NULL REFERENCES discount_codes(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
    amount_applied_minor INTEGER NOT NULL DEFAULT 0 CHECK (amount_applied_minor >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS discount_redemptions_code_idx ON discount_redemptions(discount_code_id);
CREATE INDEX IF NOT EXISTS discount_redemptions_customer_idx ON discount_redemptions(customer_id);

CREATE TABLE IF NOT EXISTS referral_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
    code TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referral_redemptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referral_code_id UUID NOT NULL REFERENCES referral_codes(id) ON DELETE CASCADE,
    referred_customer_id UUID NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','rewarded','unfulfilled')),
    reward_note TEXT,
    rewarded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS referral_redemptions_code_idx ON referral_redemptions(referral_code_id);
CREATE INDEX IF NOT EXISTS referral_redemptions_status_idx ON referral_redemptions(status);

INSERT INTO platform_settings(setting_key, setting_value)
VALUES ('referral_program', '{"rewardDays": 7, "enabled": true}'::jsonb)
ON CONFLICT (setting_key) DO NOTHING;

COMMIT;
