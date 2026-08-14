CREATE TABLE IF NOT EXISTS request_service_settings (
    id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled boolean NOT NULL DEFAULT FALSE,
    base_url text,
    api_key_encrypted text,
    sync_interval_minutes integer NOT NULL DEFAULT 15 CHECK (sync_interval_minutes BETWEEN 5 AND 1440),
    updated_by uuid,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW()
);

-- Preserve the URL already configured in Settings as a compatibility fallback.
-- We intentionally do not copy any plaintext API key into the database.
INSERT INTO request_service_settings(id,enabled,base_url,sync_interval_minutes)
SELECT 1,
       FALSE,
       NULLIF(setting_value->>'overseerrUrl',''),
       15
FROM platform_settings
WHERE setting_key='platform'
ON CONFLICT (id) DO NOTHING;
