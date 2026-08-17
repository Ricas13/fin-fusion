BEGIN;

-- Price edits deliberately deactivate their provider mappings until the
-- provider amount/currency/recurrence/active state has been checked again.
-- Represent that catalogue state explicitly rather than overloading an error.
ALTER TABLE plan_provider_prices DROP CONSTRAINT IF EXISTS plan_provider_prices_verification_status_check;
ALTER TABLE plan_provider_prices
    ADD CONSTRAINT plan_provider_prices_verification_status_check
    CHECK (verification_status IS NULL OR verification_status IN ('unverified','verified','drift','error','not_required'));

COMMIT;
