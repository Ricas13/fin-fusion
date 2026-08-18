ALTER TABLE stremio_sources
  ADD COLUMN IF NOT EXISTS password_encrypted text,
  ADD COLUMN IF NOT EXISTS token_rotation_enabled boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS token_rotation_hours integer DEFAULT 12 NOT NULL,
  ADD COLUMN IF NOT EXISTS token_rotates_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS token_last_rotated_at timestamp with time zone,
  ADD CONSTRAINT stremio_sources_rotation_hours_check CHECK (token_rotation_hours BETWEEN 1 AND 168);

CREATE INDEX IF NOT EXISTS stremio_sources_token_rotation_idx
  ON stremio_sources(enabled, token_rotates_at)
  WHERE token_rotation_enabled = true AND password_encrypted IS NOT NULL;

COMMENT ON COLUMN stremio_sources.password_encrypted IS 'Optional encrypted dedicated Jellyfin source password used only for automatic access-token rotation.';
