BEGIN;

-- Managed customer playback is already attributable through jellyfin_account_id.
-- Telemetry-only Jellyfin administrators intentionally have no customer/account row,
-- so retain the Jellyfin identity directly on history for analytics without making
-- the administrator subject to provisioning, billing, inactivity, or stream policy.
ALTER TABLE playback_history
    ADD COLUMN IF NOT EXISTS jellyfin_user_id text;

CREATE INDEX IF NOT EXISTS playback_history_jellyfin_identity_started_idx
    ON playback_history (server_id, LOWER(jellyfin_user_id), started_at DESC)
    WHERE jellyfin_user_id IS NOT NULL;

COMMENT ON COLUMN playback_history.jellyfin_user_id IS
    'Jellyfin user identity for telemetry-only playback (for example unmanaged server administrators). Managed customer history may leave this null and resolve identity through jellyfin_account_id.';

COMMIT;
