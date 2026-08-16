BEGIN;

ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_addon_service_type_check;
ALTER TABLE plans
    ADD CONSTRAINT plans_addon_service_type_check
    CHECK (is_addon=FALSE OR service_type='stremio');

COMMENT ON CONSTRAINT plans_addon_service_type_check ON plans IS
'Independent add-ons are Stremio-only. Jellyfin + Stremio must be sold as a bundle so primary Jellyfin provisioning remains unambiguous.';

COMMIT;
