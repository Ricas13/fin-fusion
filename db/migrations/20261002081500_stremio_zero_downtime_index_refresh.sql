BEGIN;

-- A completed Stremio managed index remains the serving snapshot while the
-- next generation is built. "queued" therefore means work is pending, not
-- that the current catalogue is unavailable.
ALTER TABLE stremio_media_index_state
  DROP CONSTRAINT IF EXISTS stremio_media_index_state_status_check;

ALTER TABLE stremio_media_index_state
  ADD CONSTRAINT stremio_media_index_state_status_check
  CHECK (status IN ('never','queued','running','ready','failed'));

-- Managed Jellyfin scans are written here first. The serving table is replaced
-- from one completed generation inside a single transaction, so readers see
-- either the previous complete snapshot or the new complete snapshot.
CREATE TABLE IF NOT EXISTS stremio_media_index_build (
  generation uuid NOT NULL,
  server_id uuid NOT NULL REFERENCES jellyfin_servers(id) ON DELETE CASCADE,
  imdb_id text NOT NULL,
  item_id text NOT NULL,
  item_type text NOT NULL,
  name text,
  production_year integer,
  path text,
  updated_at timestamp with time zone DEFAULT NOW() NOT NULL,
  seen_at timestamp with time zone DEFAULT NOW() NOT NULL,
  PRIMARY KEY(generation,server_id,item_id),
  CONSTRAINT stremio_media_index_build_item_type_check
    CHECK (item_type IN ('Movie','Series'))
);

CREATE INDEX IF NOT EXISTS stremio_media_index_build_server_generation_idx
  ON stremio_media_index_build(server_id,generation);

COMMENT ON TABLE stremio_media_index_build IS
  'Shadow generations for zero-downtime managed Stremio index refreshes. Only a completed generation is atomically promoted to stremio_media_index.';

COMMIT;
