BEGIN;

ALTER TABLE public.stremio_managed_accounts
    ADD COLUMN IF NOT EXISTS playback_password_encrypted text;

COMMENT ON COLUMN public.stremio_managed_accounts.playback_password_encrypted IS
    'Encrypted password for the hidden managed Stremio user. Used only to mint per-playback Jellyfin device tokens.';

ALTER TABLE public.stremio_source_playback_leases
    ADD COLUMN IF NOT EXISTS managed_mapping_id uuid REFERENCES public.stremio_managed_accounts(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS server_id uuid REFERENCES public.jellyfin_servers(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS jellyfin_user_id uuid,
    ADD COLUMN IF NOT EXISTS device_id text,
    ADD COLUMN IF NOT EXISTS play_session_id text,
    ADD COLUMN IF NOT EXISTS media_source_id text,
    ADD COLUMN IF NOT EXISTS jellyfin_session_id text,
    ADD COLUMN IF NOT EXISTS playback_token_encrypted text,
    ADD COLUMN IF NOT EXISTS position_ticks bigint,
    ADD COLUMN IF NOT EXISTS lifecycle_started_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS lifecycle_last_seen_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS stremio_managed_playback_lifecycle_idx
    ON public.stremio_source_playback_leases(server_id, managed_mapping_id, expires_at)
    WHERE managed_mapping_id IS NOT NULL;

COMMIT;
