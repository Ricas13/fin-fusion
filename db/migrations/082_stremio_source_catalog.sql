BEGIN;

ALTER TABLE stremio_sources
  ADD COLUMN IF NOT EXISTS auth_state TEXT NOT NULL DEFAULT 'connected',
  ADD COLUMN IF NOT EXISTS last_connected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_auth_check_at TIMESTAMPTZ;
ALTER TABLE stremio_sources DROP CONSTRAINT IF EXISTS stremio_sources_auth_state_check;
ALTER TABLE stremio_sources ADD CONSTRAINT stremio_sources_auth_state_check CHECK(auth_state IN ('connected','reconnect_required','error'));
UPDATE stremio_sources SET last_connected_at=COALESCE(last_connected_at,created_at) WHERE last_connected_at IS NULL;

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
CREATE INDEX IF NOT EXISTS stremio_source_libraries_selected_idx ON stremio_source_libraries(source_id,selected,available);

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
CREATE INDEX IF NOT EXISTS stremio_source_media_imdb_idx ON stremio_source_media_index(source_id,imdb_id,item_type);
CREATE INDEX IF NOT EXISTS stremio_source_media_library_idx ON stremio_source_media_index(source_id,library_id);

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
SELECT id,'queued',NOW(),TRUE FROM stremio_sources ON CONFLICT(source_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS plan_stremio_sources (
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES stremio_sources(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  priority INTEGER NOT NULL DEFAULT 100 CHECK(priority BETWEEN 1 AND 10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(plan_id,source_id)
);
CREATE INDEX IF NOT EXISTS plan_stremio_sources_source_idx ON plan_stremio_sources(source_id,plan_id) WHERE enabled=TRUE;

CREATE TABLE IF NOT EXISTS stremio_source_playback_leases (
  lease_hash TEXT PRIMARY KEY,
  entitlement_id UUID NOT NULL REFERENCES stremio_entitlements(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES stremio_sources(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS stremio_source_playback_leases_entitlement_idx ON stremio_source_playback_leases(entitlement_id,expires_at);
CREATE INDEX IF NOT EXISTS stremio_source_playback_leases_expiry_idx ON stremio_source_playback_leases(expires_at);

-- Source-only plans no longer need a CAPTAiNFiN-managed Jellyfin identity. The
-- install credential remains customer/subscription bound; either an explicit
-- shared source mapping OR the legacy managed-server identity makes an active
-- entitlement complete.
CREATE OR REPLACE FUNCTION enforce_stremio_entitlement_integrity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sub_customer UUID;
  sub_service TEXT;
  sub_plan UUID;
  account_customer UUID;
  account_server UUID;
  account_purpose_value TEXT;
  server_allowed BOOLEAN;
  shared_sources BOOLEAN;
BEGIN
  SELECT customer_id,COALESCE(service_type_snapshot,'jellyfin'),plan_id
    INTO sub_customer,sub_service,sub_plan FROM subscriptions WHERE id=NEW.subscription_id;
  IF sub_customer IS NULL OR sub_customer<>NEW.customer_id THEN RAISE EXCEPTION 'Stremio subscription/customer mismatch'; END IF;
  IF sub_service NOT IN ('stremio','bundle') THEN RAISE EXCEPTION 'Stremio entitlement requires a stremio or bundle subscription'; END IF;

  SELECT EXISTS(SELECT 1 FROM plan_stremio_sources WHERE plan_id=sub_plan AND enabled=TRUE) INTO shared_sources;

  IF NEW.status<>'revoked' AND NEW.server_id IS NOT NULL THEN
    SELECT stremio_enabled INTO server_allowed FROM jellyfin_servers WHERE id=NEW.server_id;
    IF COALESCE(server_allowed,FALSE)=FALSE THEN RAISE EXCEPTION 'Assigned Jellyfin server is not enabled for Stremio'; END IF;
  END IF;

  IF NEW.jellyfin_account_id IS NOT NULL THEN
    SELECT customer_id,server_id,account_purpose INTO account_customer,account_server,account_purpose_value FROM jellyfin_accounts WHERE id=NEW.jellyfin_account_id;
    IF account_customer IS NULL OR account_customer<>NEW.customer_id OR account_server IS DISTINCT FROM NEW.server_id THEN RAISE EXCEPTION 'Stremio Jellyfin account ownership/server mismatch'; END IF;
    IF account_purpose_value<>'stremio_internal' THEN RAISE EXCEPTION 'Stremio entitlement requires a dedicated internal Jellyfin account'; END IF;
  END IF;

  IF NEW.status='active' AND NEW.token_hash IS NULL THEN RAISE EXCEPTION 'Active Stremio entitlement requires an install credential'; END IF;
  IF NEW.status='active' AND NOT shared_sources AND (NEW.server_id IS NULL OR NEW.jellyfin_account_id IS NULL OR NEW.jellyfin_access_token_encrypted IS NULL) THEN
    RAISE EXCEPTION 'Active Stremio entitlement requires either selected shared sources or a managed Jellyfin delivery identity';
  END IF;
  IF NEW.status='active' AND shared_sources AND ((NEW.server_id IS NULL) <> (NEW.jellyfin_account_id IS NULL)) THEN
    RAISE EXCEPTION 'Managed Jellyfin delivery identity must be complete when attached to a shared-source entitlement';
  END IF;
  IF NEW.status='revoked' AND NEW.revoked_at IS NULL THEN NEW.revoked_at:=NOW(); ELSIF NEW.status<>'revoked' THEN NEW.revoked_at:=NULL; END IF;
  NEW.updated_at:=NOW();RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS stremio_entitlement_integrity_trigger ON stremio_entitlements;
DROP TRIGGER IF EXISTS stremio_entitlements_integrity ON stremio_entitlements;
CREATE TRIGGER stremio_entitlement_integrity_trigger BEFORE INSERT OR UPDATE ON stremio_entitlements FOR EACH ROW EXECUTE FUNCTION enforce_stremio_entitlement_integrity();

COMMENT ON TABLE stremio_source_libraries IS 'Libraries visible to the dedicated Jellyfin source account. Only selected libraries are indexed for Stremio.';
COMMENT ON TABLE stremio_source_media_index IS 'Local IMDb lookup index for selected libraries on external/shared Jellyfin Stremio sources.';
COMMENT ON TABLE stremio_source_index_state IS 'Per-source lightweight sync state: six-hour incremental indexing with periodic full reconciliation.';
COMMENT ON TABLE plan_stremio_sources IS 'Per-plan Stremio source allow-list and priority. Empty mapping preserves compatibility with the managed-server delivery path.';
COMMENT ON TABLE stremio_source_playback_leases IS 'Short-lived CAPTAiNFiN admission leases enforcing per-entitlement external Stremio stream concurrency.';

COMMIT;
