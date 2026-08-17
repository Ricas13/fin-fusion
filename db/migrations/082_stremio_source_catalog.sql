BEGIN;

ALTER TABLE stremio_sources
  ADD COLUMN IF NOT EXISTS auth_state TEXT NOT NULL DEFAULT 'connected',
  ADD COLUMN IF NOT EXISTS last_connected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_auth_check_at TIMESTAMPTZ;

ALTER TABLE stremio_sources
  DROP CONSTRAINT IF EXISTS stremio_sources_auth_state_check;
ALTER TABLE stremio_sources
  ADD CONSTRAINT stremio_sources_auth_state_check
  CHECK(auth_state IN ('connected','reconnect_required','error'));

UPDATE stremio_sources
SET last_connected_at=COALESCE(last_connected_at,created_at)
WHERE last_connected_at IS NULL;

CREATE TABLE IF NOT EXISTS stremio_source_libraries (
  source_id UUID NOT NULL REFERENCES stremio_sources(id) ON DELETE CASCADE,
  library_id TEXT NOT NULL,
  name TEXT NOT NULL,
  collection_type TEXT,
  selected BOOLEAN NOT NULL DEFAULT FALSE,
  available BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(source_id,library_id)
);
CREATE INDEX IF NOT EXISTS stremio_source_libraries_selected_idx
  ON stremio_source_libraries(source_id,selected,available);

CREATE TABLE IF NOT EXISTS stremio_source_media_index (
  source_id UUID NOT NULL REFERENCES stremio_sources(id) ON DELETE CASCADE,
  library_id TEXT NOT NULL,
  imdb_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK(item_type IN ('Movie','Series')),
  name TEXT,
  production_year INTEGER,
  path TEXT,
  date_last_saved TIMESTAMPTZ,
  scan_generation UUID NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(source_id,item_id)
);
CREATE INDEX IF NOT EXISTS stremio_source_media_imdb_idx
  ON stremio_source_media_index(source_id,imdb_id,item_type);
CREATE INDEX IF NOT EXISTS stremio_source_media_library_idx
  ON stremio_source_media_index(source_id,library_id);

CREATE TABLE IF NOT EXISTS stremio_source_index_state (
  source_id UUID PRIMARY KEY REFERENCES stremio_sources(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'never' CHECK(status IN ('never','queued','running','ready','failed')),
  last_mode TEXT CHECK(last_mode IS NULL OR last_mode IN ('full','incremental')),
  last_started_at TIMESTAMPTZ,
  last_completed_at TIMESTAMPTZ,
  last_full_completed_at TIMESTAMPTZ,
  next_incremental_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  force_full BOOLEAN NOT NULL DEFAULT TRUE,
  item_count INTEGER NOT NULL DEFAULT 0 CHECK(item_count>=0),
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO stremio_source_index_state(source_id,status,next_incremental_at,force_full)
SELECT id,'queued',NOW(),TRUE FROM stremio_sources
ON CONFLICT(source_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS plan_stremio_sources (
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES stremio_sources(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  priority INTEGER NOT NULL DEFAULT 100 CHECK(priority BETWEEN 1 AND 10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(plan_id,source_id)
);
CREATE INDEX IF NOT EXISTS plan_stremio_sources_source_idx
  ON plan_stremio_sources(source_id,plan_id)
  WHERE enabled=TRUE;

COMMENT ON TABLE stremio_source_libraries IS
'Libraries visible to the dedicated Jellyfin source account. Only selected libraries are indexed for Stremio.';
COMMENT ON TABLE stremio_source_media_index IS
'Local IMDb lookup index for selected libraries on external/shared Jellyfin Stremio sources.';
COMMENT ON TABLE stremio_source_index_state IS
'Per-source lightweight sync state: six-hour incremental indexing with periodic full reconciliation.';
COMMENT ON TABLE plan_stremio_sources IS
'Optional per-plan Stremio source allow-list and priority. Empty mapping preserves compatibility by allowing all enabled ready sources.';

COMMIT;
