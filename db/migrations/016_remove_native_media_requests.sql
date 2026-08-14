BEGIN;

-- Removes the native TMDB/Radarr/Sonarr request subsystem (010/011), replaced
-- by a configurable link to an external Overseerr/Seerr instance. The base
-- content_requests table predates this subsystem (001_platform.sql) and is
-- kept -- it's still used by the generic admin request queue and the
-- reseller portal's content-request feature, both unrelated to Arr/TMDB.

DROP VIEW IF EXISTS media_admin_queue;
DROP VIEW IF EXISTS media_route_details;
DROP VIEW IF EXISTS media_quality_options;
DROP VIEW IF EXISTS media_jobs;

DROP INDEX IF EXISTS content_requests_tmdb_idx;
DROP INDEX IF EXISTS content_requests_arr_tracking_idx;
DROP INDEX IF EXISTS request_routes_instance_idx;

ALTER TABLE content_requests
    DROP COLUMN IF EXISTS tmdb_id,
    DROP COLUMN IF EXISTS tvdb_id,
    DROP COLUMN IF EXISTS year,
    DROP COLUMN IF EXISTS poster_path,
    DROP COLUMN IF EXISTS backdrop_path,
    DROP COLUMN IF EXISTS quality_tier_id,
    DROP COLUMN IF EXISTS arr_instance_id,
    DROP COLUMN IF EXISTS arr_item_id,
    DROP COLUMN IF EXISTS routed_at,
    DROP COLUMN IF EXISTS last_status_check,
    DROP COLUMN IF EXISTS available_at,
    DROP COLUMN IF EXISTS last_error;

-- Restore the original constraint from 001_platform.sql: 'added' was the only
-- status value 010_request_portal_routing.sql introduced (searching/available/
-- failed already existed generically and predate the Arr subsystem).
ALTER TABLE content_requests DROP CONSTRAINT IF EXISTS content_requests_status_check;
ALTER TABLE content_requests ADD CONSTRAINT content_requests_status_check
    CHECK (status IN ('pending','approved','declined','searching','available','failed'));

DROP TABLE IF EXISTS request_routes;
DROP TABLE IF EXISTS request_quality_tiers;
DROP TABLE IF EXISTS arr_instances;

COMMIT;
