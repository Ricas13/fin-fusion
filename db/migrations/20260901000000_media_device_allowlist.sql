BEGIN;

CREATE TABLE IF NOT EXISTS media_account_device_policy (
    jellyfin_account_id uuid PRIMARY KEY REFERENCES jellyfin_accounts(id) ON DELETE CASCADE,
    managed boolean NOT NULL DEFAULT FALSE,
    enforced boolean NOT NULL DEFAULT FALSE,
    device_limit integer,
    last_applied_devices text[] NOT NULL DEFAULT '{}'::text[],
    last_applied_at timestamp with time zone,
    last_error text,
    reset_at timestamp with time zone,
    updated_at timestamp with time zone NOT NULL DEFAULT NOW(),
    CONSTRAINT media_account_device_policy_limit_check CHECK (device_limit IS NULL OR (device_limit >= 1 AND device_limit <= 200))
);

CREATE TABLE IF NOT EXISTS media_account_devices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    jellyfin_account_id uuid NOT NULL REFERENCES jellyfin_accounts(id) ON DELETE CASCADE,
    device_id text NOT NULL,
    device_name text,
    client_name text,
    registered_at timestamp with time zone NOT NULL DEFAULT NOW(),
    last_seen_at timestamp with time zone NOT NULL DEFAULT NOW(),
    revoked_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT NOW(),
    updated_at timestamp with time zone NOT NULL DEFAULT NOW(),
    CONSTRAINT media_account_devices_device_id_check CHECK (length(btrim(device_id)) BETWEEN 1 AND 512),
    CONSTRAINT media_account_devices_account_device_unique UNIQUE (jellyfin_account_id, device_id)
);

CREATE INDEX IF NOT EXISTS media_account_devices_active_idx
    ON media_account_devices(jellyfin_account_id, registered_at, device_id)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS media_account_devices_last_seen_idx
    ON media_account_devices(last_seen_at DESC);

COMMENT ON TABLE media_account_devices IS
    'Persistent Jellyfin/Emby device slots claimed for a managed account. Revoked rows are retained as troubleshooting history.';
COMMENT ON TABLE media_account_device_policy IS
    'Tracks CAPTAiNFiN ownership of the native Jellyfin/Emby per-user device allowlist so resets and plan changes can safely release it.';

COMMIT;
