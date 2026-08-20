BEGIN;

CREATE TABLE IF NOT EXISTS stremio_managed_source_libraries (
  server_id uuid NOT NULL REFERENCES jellyfin_servers(id) ON DELETE CASCADE,
  library_id text NOT NULL,
  name text NOT NULL,
  collection_type text,
  selected boolean DEFAULT TRUE NOT NULL,
  available boolean DEFAULT TRUE NOT NULL,
  created_at timestamp with time zone DEFAULT NOW() NOT NULL,
  updated_at timestamp with time zone DEFAULT NOW() NOT NULL,
  PRIMARY KEY(server_id, library_id)
);

CREATE INDEX IF NOT EXISTS stremio_managed_source_libraries_selected_idx
  ON stremio_managed_source_libraries(server_id, selected, available);

COMMENT ON TABLE stremio_managed_source_libraries IS
  'Per-managed-Jellyfin-server library allow-list used only by the Stremio media index.';

COMMIT;
