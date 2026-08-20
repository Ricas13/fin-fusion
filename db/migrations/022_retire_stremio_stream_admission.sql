-- Stremio subscriptions are household-based. Commercial per-stream admission
-- was retired in favour of direct control-plane redirects to Jellyfin.
-- Keep managed rows because the same table now stores short-lived Jellyfin
-- playback lifecycle credentials used only for cleanup.
DELETE FROM stremio_source_playback_leases
WHERE managed_mapping_id IS NULL;
