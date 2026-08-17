BEGIN;

-- Price edits deliberately deactivate their provider mappings until the
-- provider amount/currency/recurrence/active state has been checked again.
-- Represent that catalogue state explicitly rather than overloading an error.
ALTER TABLE plan_provider_prices DROP CONSTRAINT IF EXISTS plan_provider_prices_verification_status_check;
ALTER TABLE plan_provider_prices
    ADD CONSTRAINT plan_provider_prices_verification_status_check
    CHECK (verification_status IS NULL OR verification_status IN ('unverified','verified','drift','error','not_required'));

-- Reseller tier prices follow the same verification lifecycle. Imports and
-- price edits must be able to preserve a provider ID while keeping it disabled
-- until the remote amount/currency/recurrence/active state is verified again.
ALTER TABLE reseller_tier_provider_prices DROP CONSTRAINT IF EXISTS reseller_tier_provider_prices_verification_status_check;
ALTER TABLE reseller_tier_provider_prices
    ADD CONSTRAINT reseller_tier_provider_prices_verification_status_check
    CHECK (verification_status IS NULL OR verification_status IN ('unverified','verified','drift','error','not_required'));

COMMIT;
