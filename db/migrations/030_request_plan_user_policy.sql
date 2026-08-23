ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS request_access_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS request_permissions BIGINT,
  ADD COLUMN IF NOT EXISTS request_watchlist_sync_movies BOOLEAN,
  ADD COLUMN IF NOT EXISTS request_watchlist_sync_tv BOOLEAN,
  ADD COLUMN IF NOT EXISTS request_locale TEXT,
  ADD COLUMN IF NOT EXISTS request_discover_region TEXT,
  ADD COLUMN IF NOT EXISTS request_streaming_region TEXT,
  ADD COLUMN IF NOT EXISTS request_original_language TEXT;

ALTER TABLE plans
  DROP CONSTRAINT IF EXISTS plans_request_permissions_nonnegative;
ALTER TABLE plans
  ADD CONSTRAINT plans_request_permissions_nonnegative
  CHECK (request_permissions IS NULL OR request_permissions >= 0);
