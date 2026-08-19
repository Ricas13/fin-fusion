DO $$
BEGIN
  -- Some legacy/partially initialized databases pre-date the Stremio source
  -- media index entirely. Upgrade migrations must be safe for those installs;
  -- the clean-install baseline already contains the final table shape.
  IF to_regclass('public.stremio_source_media_index') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE 'ALTER TABLE stremio_source_media_index
    ALTER COLUMN imdb_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS tmdb_id text,
    ADD COLUMN IF NOT EXISTS tvdb_id text,
    ADD COLUMN IF NOT EXISTS title_key text';

  EXECUTE $sql$
    UPDATE stremio_source_media_index
    SET title_key=regexp_replace(lower(COALESCE(name,'')),'[^a-z0-9]+','','g')
    WHERE title_key IS NULL
  $sql$;

  EXECUTE 'CREATE INDEX IF NOT EXISTS stremio_source_media_tmdb_idx ON stremio_source_media_index(source_id,tmdb_id,item_type) WHERE tmdb_id IS NOT NULL';
  EXECUTE 'CREATE INDEX IF NOT EXISTS stremio_source_media_tvdb_idx ON stremio_source_media_index(source_id,tvdb_id,item_type) WHERE tvdb_id IS NOT NULL';
  EXECUTE 'CREATE INDEX IF NOT EXISTS stremio_source_media_title_idx ON stremio_source_media_index(source_id,title_key,item_type,production_year) WHERE title_key IS NOT NULL';
  EXECUTE $sql$COMMENT ON TABLE stremio_source_media_index IS 'Local metadata lookup index for selected libraries on external/shared Jellyfin Stremio sources.'$sql$;
END
$$;
