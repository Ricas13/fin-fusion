BEGIN;

INSERT INTO platform_settings(setting_key,setting_value)
VALUES(
  'jellyfin_lifecycle_policy_v2',
  '{"enabled":true,"dryRun":false,"freeNoPlaybackDays":7,"freeDeleteAfterDisableDays":7,"trialDeleteAfterDisableDays":30,"paidDeleteAfterDisableDays":30,"resellerDeleteAfterDisableDays":30}'::jsonb
)
ON CONFLICT(setting_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS jellyfin_account_lifecycle (
  id BIGSERIAL PRIMARY KEY,
  account_id UUID UNIQUE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  server_id UUID NOT NULL REFERENCES jellyfin_servers(id) ON DELETE CASCADE,
  jellyfin_user_id TEXT NOT NULL,
  jellyfin_username TEXT,
  category TEXT NOT NULL CHECK(category IN ('free','trial','paid','reseller')),
  reason TEXT NOT NULL,
  policy_source TEXT NOT NULL DEFAULT 'global',
  disabled_at TIMESTAMPTZ NOT NULL,
  delete_after TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  restored_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS jellyfin_account_lifecycle_due_idx
  ON jellyfin_account_lifecycle(delete_after)
  WHERE deleted_at IS NULL AND restored_at IS NULL;
CREATE INDEX IF NOT EXISTS jellyfin_account_lifecycle_customer_idx
  ON jellyfin_account_lifecycle(customer_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS stremio_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  source_kind TEXT NOT NULL DEFAULT 'external' CHECK(source_kind IN ('owned','external')),
  server_id UUID REFERENCES jellyfin_servers(id) ON DELETE SET NULL,
  base_url TEXT NOT NULL,
  public_url TEXT NOT NULL,
  jellyfin_user_id TEXT NOT NULL,
  jellyfin_username TEXT,
  access_token_encrypted TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 100 CHECK(weight BETWEEN 1 AND 10000),
  priority INTEGER NOT NULL DEFAULT 100 CHECK(priority BETWEEN 1 AND 10000),
  authorization_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(source_kind='owned' OR authorization_confirmed=TRUE)
);
CREATE INDEX IF NOT EXISTS stremio_sources_enabled_idx ON stremio_sources(enabled,priority,name);

INSERT INTO platform_settings(setting_key,setting_value)
VALUES('stremio_source_pool_v1','{"enabled":false,"selectionMode":"weighted_random"}'::jsonb)
ON CONFLICT(setting_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS stremio_stream_attribution (
  id BIGSERIAL PRIMARY KEY,
  entitlement_id UUID REFERENCES stremio_entitlements(id) ON DELETE SET NULL,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  source_id UUID REFERENCES stremio_sources(id) ON DELETE SET NULL,
  source_name TEXT NOT NULL,
  video_type TEXT NOT NULL,
  video_id TEXT NOT NULL,
  item_id TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS stremio_stream_attribution_customer_idx ON stremio_stream_attribution(customer_id,requested_at DESC);
CREATE INDEX IF NOT EXISTS stremio_stream_attribution_source_idx ON stremio_stream_attribution(source_id,requested_at DESC);

COMMENT ON TABLE jellyfin_account_lifecycle IS
'Jellyfin-only lifecycle state. Automated lifecycle must never disable/delete the CAPTAiNFiN portal customer.';
COMMENT ON TABLE stremio_sources IS
'Authorized Jellyfin bridge/service accounts used by the Stremio source pool. External sources require explicit authorization confirmation.';
COMMENT ON TABLE stremio_stream_attribution IS
'CAPTAiNFiN-side attribution of Stremio stream requests to the real portal customer while upstream Jellyfin sees the configured bridge account.';

COMMIT;
