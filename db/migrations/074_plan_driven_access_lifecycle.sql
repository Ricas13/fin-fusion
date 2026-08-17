BEGIN;

-- Storefront inventory is different from a reseller tier's downstream seat
-- allowance. A tier can, for example, let each reseller manage 50 customers
-- while CAPTAiNFiN only sells 10 subscriptions to that tier.
ALTER TABLE reseller_tiers
    ADD COLUMN IF NOT EXISTS capacity_limit INTEGER;

ALTER TABLE reseller_tiers
    DROP CONSTRAINT IF EXISTS reseller_tiers_capacity_limit_check;
ALTER TABLE reseller_tiers
    ADD CONSTRAINT reseller_tiers_capacity_limit_check
    CHECK (capacity_limit IS NULL OR capacity_limit BETWEEN 1 AND 1000000);

-- Plan-specific inactivity rules already live in plans.inactivity_policy. The
-- global cleanup setting below is intentionally about Jellyfin identities only:
-- CAPTAiNFiN portal customers are never deleted/deactivated by automation.
INSERT INTO platform_settings(setting_key,setting_value)
VALUES(
    'jellyfin_user_cleanup_v1',
    '{"enabled":false,"dryRun":true,"deleteAfterDays":30,"minimumObservationHours":24}'::jsonb
)
ON CONFLICT(setting_key) DO NOTHING;

COMMENT ON COLUMN plans.inactivity_policy IS
'Per-plan Jellyfin usage policy. Free Jellyfin/bundle plans may automatically disable Jellyfin access without altering the CAPTAiNFiN portal customer.';
COMMENT ON COLUMN reseller_tiers.capacity_limit IS
'Optional maximum number of concurrent live reseller subscriptions sold for this tier; distinct from seat_limit, which controls each reseller estate.';

COMMIT;
