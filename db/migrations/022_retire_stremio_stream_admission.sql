-- Stremio subscriptions are household-based. Commercial per-stream admission
-- was retired in favour of direct control-plane redirects to Jellyfin.
-- Keep stream_limit at the schema-compatible sentinel value of 1; it is no
-- longer a commercial or runtime concurrency allowance.
UPDATE stremio_entitlements
SET stream_limit=1,
    updated_at=NOW()
WHERE stream_limit IS DISTINCT FROM 1;

-- Keep managed rows because the same table now stores short-lived Jellyfin
-- playback lifecycle credentials used only for cleanup. Retire the old
-- external/commercial admission leases completely.
DELETE FROM stremio_source_playback_leases
WHERE managed_mapping_id IS NULL;
