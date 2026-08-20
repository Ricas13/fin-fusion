ALTER TABLE stremio_source_playback_leases
    ADD COLUMN IF NOT EXISTS play_method text;

ALTER TABLE stremio_source_playback_leases
    DROP CONSTRAINT IF EXISTS stremio_source_playback_leases_play_method_check;

ALTER TABLE stremio_source_playback_leases
    ADD CONSTRAINT stremio_source_playback_leases_play_method_check
    CHECK (play_method IS NULL OR play_method IN ('DirectPlay','DirectStream','Transcode'));
