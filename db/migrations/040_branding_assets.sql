BEGIN;

CREATE TABLE IF NOT EXISTS branding_assets (
    kind TEXT PRIMARY KEY CHECK (kind IN ('logo','favicon')),
    mime_type TEXT NOT NULL,
    file_ext TEXT NOT NULL,
    content BYTEA NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    sha256 TEXT NOT NULL,
    updated_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS branding_assets_updated_idx ON branding_assets(updated_at DESC);

COMMIT;
