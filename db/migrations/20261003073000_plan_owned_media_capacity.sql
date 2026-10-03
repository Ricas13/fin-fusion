BEGIN;

-- Jellyfin plan capacity was historically ignored in favour of server capacity.
-- Preserve existing production behaviour for the old zero sentinel by treating
-- it as "no plan-specific cap" at the ownership transition. From this migration
-- onward, administrators can explicitly save 0 to close new acquisition.
UPDATE plans
SET capacity_limit = NULL,
    updated_at = NOW()
WHERE service_type IN ('jellyfin','bundle')
  AND capacity_limit = 0;

COMMENT ON COLUMN plans.capacity_limit IS
'Plan-owned acquisition cap. For Jellyfin/Emby-style media plans this is enforced in addition to the physical capacity of the eligible server fleet; NULL means no plan-specific cap and 0 means closed to new acquisition.';

COMMIT;
