BEGIN;

ALTER TABLE public.stremio_source_playback_leases
    ALTER COLUMN source_id DROP NOT NULL;

COMMENT ON COLUMN public.stremio_source_playback_leases.source_id IS
    'Shared Stremio source id; NULL for portal-managed hidden Jellyfin playback.';

COMMIT;
