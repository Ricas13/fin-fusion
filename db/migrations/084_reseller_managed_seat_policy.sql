BEGIN;

-- Resellers buy a monthly allowance of managed Jellyfin users.  The reseller
-- tier itself is the service policy; downstream users no longer need to be
-- assigned a retail customer plan or have a reseller-side sale recorded.
ALTER TABLE reseller_tiers
    ADD COLUMN IF NOT EXISTS server_class TEXT NOT NULL DEFAULT 'premium',
    ADD COLUMN IF NOT EXISTS streams INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS allow_downloads BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS allow_video_transcoding BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS allow_audio_transcoding BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS allow_remuxing BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS allow_live_tv BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS allow_live_tv_management BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS allow_remote_access BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS allow_4k BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS library_access_mode TEXT NOT NULL DEFAULT 'all',
    ADD COLUMN IF NOT EXISTS library_names TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS placement_strategy TEXT NOT NULL DEFAULT 'least_users',
    ADD COLUMN IF NOT EXISTS capacity_limit INTEGER;

ALTER TABLE reseller_tiers DROP CONSTRAINT IF EXISTS reseller_tiers_server_class_check;
ALTER TABLE reseller_tiers ADD CONSTRAINT reseller_tiers_server_class_check
    CHECK (server_class IN ('premium','free','custom'));
ALTER TABLE reseller_tiers DROP CONSTRAINT IF EXISTS reseller_tiers_streams_check;
ALTER TABLE reseller_tiers ADD CONSTRAINT reseller_tiers_streams_check
    CHECK (streams BETWEEN 1 AND 50);
ALTER TABLE reseller_tiers DROP CONSTRAINT IF EXISTS reseller_tiers_library_access_mode_check;
ALTER TABLE reseller_tiers ADD CONSTRAINT reseller_tiers_library_access_mode_check
    CHECK (library_access_mode IN ('all','include','exclude'));
ALTER TABLE reseller_tiers DROP CONSTRAINT IF EXISTS reseller_tiers_placement_strategy_check;
ALTER TABLE reseller_tiers ADD CONSTRAINT reseller_tiers_placement_strategy_check
    CHECK (placement_strategy IN ('least_users','least_streams','weighted'));
ALTER TABLE reseller_tiers DROP CONSTRAINT IF EXISTS reseller_tiers_capacity_limit_check;
ALTER TABLE reseller_tiers ADD CONSTRAINT reseller_tiers_capacity_limit_check
    CHECK (capacity_limit IS NULL OR capacity_limit >= 0);

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS reseller_managed BOOLEAN NOT NULL DEFAULT FALSE;

-- Existing reseller-owned customer records become managed seats.  Historical
-- subscriptions and sales are intentionally preserved for audit/migration
-- history, but the runtime no longer depends on them for reseller access.
UPDATE customers
SET reseller_managed=TRUE,
    updated_at=NOW()
WHERE reseller_id IS NOT NULL
  AND COALESCE(is_reseller_owner,FALSE)=FALSE;

CREATE INDEX IF NOT EXISTS customers_reseller_managed_idx
    ON customers(reseller_id,created_at)
    WHERE reseller_managed=TRUE;

-- Old tier-to-retail-plan rules remain as historical rows only.  New reseller
-- provisioning is driven directly by the policy columns above.
COMMENT ON TABLE reseller_tier_plan_rules IS
    'Legacy downstream-plan rules retained for historical compatibility; reseller managed-user provisioning no longer reads this table.';
COMMENT ON TABLE reseller_sales IS
    'Historical reseller-entered sales ledger retained for audit only; no live reseller workflow writes this table.';
COMMENT ON TABLE credit_transactions IS
    'Historical legacy reseller credit ledger retained for audit only; reseller seat licensing does not read or write it.';

COMMIT;
