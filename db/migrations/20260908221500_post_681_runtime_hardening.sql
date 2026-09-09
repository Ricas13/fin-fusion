BEGIN;

-- External fallback playback remains a direct Stremio -> Jellyfin/Emby path.
-- These rows hold per-entitlement login sessions so customer-visible raw URLs
-- never disclose the durable source-maintenance credential.
CREATE TABLE IF NOT EXISTS stremio_external_playback_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID NOT NULL,
    entitlement_id UUID NOT NULL,
    base_url TEXT NOT NULL,
    source_name TEXT,
    media_server_type VARCHAR(16) NOT NULL DEFAULT 'jellyfin',
    token_encrypted TEXT NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    last_revoke_attempt_at TIMESTAMPTZ,
    revoke_attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    UNIQUE(source_id, entitlement_id)
);

CREATE INDEX IF NOT EXISTS stremio_external_playback_tokens_expiry_idx
    ON stremio_external_playback_tokens(expires_at,id);

COMMENT ON TABLE stremio_external_playback_tokens IS
    'Encrypted per-entitlement external media-server sessions used only in fully raw/direct Stremio playback URLs.';

-- A placement lease is acquired before any remote Jellyfin account is created.
-- It is counted as a user immediately, preventing concurrent reconciliations
-- from both observing and consuming the same final server slot.
CREATE TABLE IF NOT EXISTS jellyfin_server_placement_leases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    server_id UUID NOT NULL REFERENCES jellyfin_servers(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(customer_id,server_id)
);

CREATE INDEX IF NOT EXISTS jellyfin_server_placement_leases_expiry_idx
    ON jellyfin_server_placement_leases(server_id,expires_at);

COMMENT ON TABLE jellyfin_server_placement_leases IS
    'Short-lived user-capacity reservations acquired before remote Jellyfin account creation.';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'steamfusion_app') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.stremio_external_playback_tokens TO steamfusion_app';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.jellyfin_server_placement_leases TO steamfusion_app';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'steamfusion_automation') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.stremio_external_playback_tokens TO steamfusion_automation';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.jellyfin_server_placement_leases TO steamfusion_automation';
    END IF;
END $$;

COMMIT;
