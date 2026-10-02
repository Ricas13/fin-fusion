BEGIN;

-- Jellyfin/bundle capacity_limit values were intentionally ignored before this
-- release because fleet max_users was the sole authority. Some installations
-- therefore contain stale values (including zero) left by older admin screens.
-- Reset those no-op values before capacity_limit becomes an enforced plan-owned
-- ceiling so this migration cannot unexpectedly close a working storefront.
UPDATE plans
SET capacity_limit=NULL,
    updated_at=NOW()
WHERE service_type IN ('jellyfin','bundle')
  AND capacity_limit IS NOT NULL;

COMMENT ON COLUMN plans.capacity_limit IS
'Plan-owned acquisition ceiling. For Jellyfin/bundle plans it is enforced in addition to eligible server max_users; NULL means no additional plan cap and 0 closes new acquisition.';

COMMIT;
