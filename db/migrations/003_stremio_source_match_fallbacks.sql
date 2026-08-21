DO $migration$
BEGIN
  IF to_regclass('public.stremio_source_media_index') IS NULL THEN
    RAISE NOTICE 'stremio_source_media_index is not present; skipping source-match fallback migration for adopted skeletal schema';
    RETURN;
  END IF;

  ALTER TABLE stremio_source_media_index
    ALTER COLUMN imdb_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS tmdb_id text,
    ADD COLUMN IF NOT EXISTS tvdb_id text,
    ADD COLUMN IF NOT EXISTS title_key text;

  UPDATE stremio_source_media_index
  SET title_key=regexp_replace(lower(COALESCE(name,'')),'[^a-z0-9]+','','g')
  WHERE title_key IS NULL;

  CREATE INDEX IF NOT EXISTS stremio_source_media_tmdb_idx ON stremio_source_media_index(source_id,tmdb_id,item_type) WHERE tmdb_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS stremio_source_media_tvdb_idx ON stremio_source_media_index(source_id,tvdb_id,item_type) WHERE tvdb_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS stremio_source_media_title_idx ON stremio_source_media_index(source_id,title_key,item_type,production_year) WHERE title_key IS NOT NULL;

  COMMENT ON TABLE stremio_source_media_index IS 'Local metadata lookup index for selected libraries on external/shared Jellyfin Stremio sources.';
END
$migration$;
