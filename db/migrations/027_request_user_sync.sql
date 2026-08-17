BEGIN;

-- Tracks the one central request-system identity associated with each managed
-- CAPTAiNFiN customer. This is intentionally customer-scoped rather than
-- Jellyfin-account-scoped: one customer may move between or exist on many
-- Jellyfin servers, but should have only one Overseerr/Seerr identity.
CREATE TABLE IF NOT EXISTS request_user_sync (
    customer_id UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
    external_user_id BIGINT,
    external_email TEXT,
    external_username TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','synced','skipped','failed')),
    password_reset_required BOOLEAN NOT NULL DEFAULT FALSE,
    last_error TEXT,
    last_attempt_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS request_user_sync_status_idx
    ON request_user_sync(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS request_user_sync_external_user_idx
    ON request_user_sync(external_user_id)
    WHERE external_user_id IS NOT NULL;

COMMIT;
