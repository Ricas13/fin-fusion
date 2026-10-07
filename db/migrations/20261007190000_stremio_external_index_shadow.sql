BEGIN;

CREATE TABLE IF NOT EXISTS public.stremio_source_media_index_build (
  generation uuid NOT NULL,
  source_id uuid NOT NULL REFERENCES public.stremio_sources(id) ON DELETE CASCADE,
  library_id text NOT NULL,
  imdb_id text,
  tmdb_id text,
  tvdb_id text,
  title_key text,
  item_id text NOT NULL,
  item_type text NOT NULL,
  name text,
  production_year integer,
  path text,
  date_last_saved timestamp with time zone,
  updated_at timestamp with time zone DEFAULT NOW() NOT NULL,
  seen_at timestamp with time zone DEFAULT NOW() NOT NULL,
  PRIMARY KEY(generation,source_id,item_id),
  CONSTRAINT stremio_source_media_index_build_item_type_check
    CHECK (item_type IN ('Movie','Series'))
);

CREATE INDEX IF NOT EXISTS stremio_source_media_index_build_source_generation_idx
  ON public.stremio_source_media_index_build(source_id,generation);

COMMENT ON TABLE public.stremio_source_media_index_build IS
  'Shadow generations for full external/shared Stremio source refreshes. Serving rows are replaced only after a complete generation succeeds.';

COMMIT;
