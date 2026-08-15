BEGIN;

ALTER TABLE plan_provider_prices
    ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS verification_status TEXT,
    ADD COLUMN IF NOT EXISTS verification_error TEXT,
    ADD COLUMN IF NOT EXISTS remote_amount_minor INTEGER,
    ADD COLUMN IF NOT EXISTS remote_currency CHAR(3),
    ADD COLUMN IF NOT EXISTS remote_interval TEXT,
    ADD COLUMN IF NOT EXISTS remote_active BOOLEAN;

ALTER TABLE plan_provider_prices DROP CONSTRAINT IF EXISTS plan_provider_prices_verification_status_check;
ALTER TABLE plan_provider_prices
    ADD CONSTRAINT plan_provider_prices_verification_status_check
    CHECK (verification_status IS NULL OR verification_status IN ('verified','drift','error','not_required'));

ALTER TABLE reseller_tier_provider_prices
    ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS verification_status TEXT,
    ADD COLUMN IF NOT EXISTS verification_error TEXT,
    ADD COLUMN IF NOT EXISTS remote_amount_minor INTEGER,
    ADD COLUMN IF NOT EXISTS remote_currency CHAR(3),
    ADD COLUMN IF NOT EXISTS remote_interval TEXT,
    ADD COLUMN IF NOT EXISTS remote_active BOOLEAN;

ALTER TABLE reseller_tier_provider_prices DROP CONSTRAINT IF EXISTS reseller_tier_provider_prices_verification_status_check;
ALTER TABLE reseller_tier_provider_prices
    ADD CONSTRAINT reseller_tier_provider_prices_verification_status_check
    CHECK (verification_status IS NULL OR verification_status IN ('verified','drift','error','not_required'));

COMMIT;
