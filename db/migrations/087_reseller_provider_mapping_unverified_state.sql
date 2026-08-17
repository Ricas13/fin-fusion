BEGIN;

-- Reseller tier prices follow the same verification lifecycle as direct plan
-- provider mappings. This is intentionally a new migration: 081 was already
-- applied in production before reseller mappings adopted the unverified state.
ALTER TABLE reseller_tier_provider_prices DROP CONSTRAINT IF EXISTS reseller_tier_provider_prices_verification_status_check;
ALTER TABLE reseller_tier_provider_prices
    ADD CONSTRAINT reseller_tier_provider_prices_verification_status_check
    CHECK (verification_status IS NULL OR verification_status IN ('unverified','verified','drift','error','not_required'));

COMMIT;
