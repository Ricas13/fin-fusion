BEGIN;

-- Global lifecycle defaults. Plan-specific overrides remain in plans.inactivity_policy.
-- These settings ONLY govern Jellyfin identities. They never mutate CAPTaINFiN
-- customer/app-user identity state.
INSERT INTO platform_settings(setting_key,setting_value)
VALUES(
  'jellyfin_lifecycle_v2',
  '{"enabled":false,"dryRun":true,"freeNoPlaybackDays":7,"freeDeleteAfterDisabledDays":7,"trialDeleteAfterDisabledDays":30,"paidDeleteAfterDisabledDays":30,"resellerDeleteAfterDisabledDays":30,"minimumObservationHours":24}'::jsonb
)
ON CONFLICT(setting_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS jellyfin_account_lifecycle (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES jellyfin_accounts(id) ON DELETE SET NULL,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  server_id UUID NOT NULL REFERENCES jellyfin_servers(id) ON DELETE CASCADE,
  jellyfin_user_id TEXT NOT NULL,
  jellyfin_username TEXT,
  cause TEXT NOT NULL CHECK(cause IN('free_inactivity','trial_expired','payment_delinquent','reseller_delinquent')),
  source_key TEXT NOT NULL,
  disabled_at TIMESTAMPTZ NOT NULL,
  delete_due_at TIMESTAMPTZ NOT NULL,
  recovered_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS jellyfin_account_lifecycle_active_unique
  ON jellyfin_account_lifecycle(account_id,cause,source_key)
  WHERE account_id IS NOT NULL AND recovered_at IS NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS jellyfin_account_lifecycle_delete_due_idx
  ON jellyfin_account_lifecycle(delete_due_at)
  WHERE recovered_at IS NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS jellyfin_account_lifecycle_customer_idx
  ON jellyfin_account_lifecycle(customer_id,created_at DESC);

COMMENT ON TABLE jellyfin_account_lifecycle IS
'Jellyfin-only disable/delete lifecycle. CAPTaINFiN portal identities are never disabled or deleted by this ledger.';

-- Optional Stremio source pool. Existing per-customer Stremio delivery remains a
-- fallback when no source-pool candidate is configured/indexed.
CREATE TABLE IF NOT EXISTS stremio_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'managed' CHECK(source_type IN('managed','external')),
  managed_server_id UUID REFERENCES jellyfin_servers(id) ON DELETE SET NULL,
  base_url TEXT NOT NULL,
  public_url TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  priority INTEGER NOT NULL DEFAULT 100 CHECK(priority BETWEEN 0 AND 100000),
  weight INTEGER NOT NULL DEFAULT 100 CHECK(weight BETWEEN 1 AND 10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT stremio_source_managed_ref CHECK(
    (source_type='managed' AND managed_server_id IS NOT NULL) OR source_type='external'
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS stremio_sources_managed_unique
  ON stremio_sources(managed_server_id) WHERE managed_server_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS stremio_source_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES stremio_sources(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  jellyfin_user_id TEXT NOT NULL,
  jellyfin_username TEXT,
  access_token_encrypted TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  weight INTEGER NOT NULL DEFAULT 100 CHECK(weight BETWEEN 1 AND 10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_id,jellyfin_user_id)
);

CREATE TABLE IF NOT EXISTS stremio_source_media_index (
  source_id UUID NOT NULL REFERENCES stremio_sources(id) ON DELETE CASCADE,
  imdb_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK(item_type IN('Movie','Series')),
  name TEXT,
  production_year INTEGER,
  path TEXT,
  scan_generation UUID NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(source_id,item_id)
);
CREATE INDEX IF NOT EXISTS stremio_source_media_imdb_idx
  ON stremio_source_media_index(imdb_id,item_type,source_id);

CREATE TABLE IF NOT EXISTS stremio_source_index_state (
  source_id UUID PRIMARY KEY REFERENCES stremio_sources(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'never' CHECK(status IN('never','running','ready','failed')),
  last_started_at TIMESTAMPTZ,
  last_completed_at TIMESTAMPTZ,
  item_count INTEGER NOT NULL DEFAULT 0 CHECK(item_count>=0),
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stremio_stream_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_id UUID REFERENCES stremio_entitlements(id) ON DELETE SET NULL,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES stremio_sources(id) ON DELETE CASCADE,
  source_account_id UUID REFERENCES stremio_source_accounts(id) ON DELETE SET NULL,
  video_id TEXT NOT NULL,
  imdb_id TEXT,
  item_type TEXT,
  item_id TEXT,
  media_source_id TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS stremio_stream_requests_customer_idx
  ON stremio_stream_requests(customer_id,requested_at DESC);
CREATE INDEX IF NOT EXISTS stremio_stream_requests_source_idx
  ON stremio_stream_requests(source_id,requested_at DESC);

INSERT INTO platform_settings(setting_key,setting_value)
VALUES('stremio_source_pool_v1','{"strategy":"weighted_random"}'::jsonb)
ON CONFLICT(setting_key) DO NOTHING;

COMMENT ON TABLE stremio_sources IS
'Authorized Jellyfin sources for CAPTaINFiN Stremio aggregation. External sources require explicit credentials and outbound URL policy approval.';
COMMENT ON TABLE stremio_source_accounts IS
'Explicitly configured Jellyfin bridge identities used for Stremio source access; never arbitrary customer impersonation.';
COMMENT ON TABLE stremio_stream_requests IS
'CAPTaINFiN-side attribution of Stremio stream requests to the real portal customer and selected upstream source.';

COMMIT;
