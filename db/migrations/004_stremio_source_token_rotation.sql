DO $$
BEGIN
  -- Legacy/partially initialized databases may not contain the Stremio
  -- source subsystem. The clean-install baseline already contains the final
  -- columns, so this upgrade migration is only relevant when the table exists.
  IF to_regclass('public.stremio_sources') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE 'ALTER TABLE stremio_sources
    ADD COLUMN IF NOT EXISTS password_encrypted text,
    ADD COLUMN IF NOT EXISTS token_rotation_enabled boolean DEFAULT false NOT NULL,
    ADD COLUMN IF NOT EXISTS token_rotation_hours integer DEFAULT 12 NOT NULL,
    ADD COLUMN IF NOT EXISTS token_rotates_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS token_last_rotated_at timestamp with time zone';

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='stremio_sources_rotation_hours_check'
      AND conrelid='public.stremio_sources'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE stremio_sources ADD CONSTRAINT stremio_sources_rotation_hours_check CHECK (token_rotation_hours BETWEEN 1 AND 168)';
  END IF;

  EXECUTE 'CREATE INDEX IF NOT EXISTS stremio_sources_token_rotation_idx
    ON stremio_sources(enabled, token_rotates_at)
    WHERE token_rotation_enabled = true AND password_encrypted IS NOT NULL';

  EXECUTE $sql$COMMENT ON COLUMN stremio_sources.password_encrypted IS 'Optional encrypted dedicated Jellyfin source password used only for automatic access-token rotation.'$sql$;
END
$$;
