BEGIN;

-- Explicitly track the account CAPTAiNFiN should consider the customer's
-- current Jellyfin home. Historical installs may have multiple disabled
-- accounts from plan/server changes; choose the newest enabled/non-disabled
-- account as the initial primary without deleting anything.
ALTER TABLE jellyfin_accounts
    ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS password_reset_required BOOLEAN NOT NULL DEFAULT FALSE;

WITH ranked AS (
    SELECT ja.id,
           ROW_NUMBER() OVER (
               PARTITION BY ja.customer_id
               ORDER BY ja.disabled ASC, js.enabled DESC,
                        COALESCE(ja.updated_at, ja.created_at) DESC,
                        ja.created_at DESC, ja.id DESC
           ) AS rn
    FROM jellyfin_accounts ja
    JOIN jellyfin_servers js ON js.id=ja.server_id
)
UPDATE jellyfin_accounts ja
SET is_primary=TRUE
FROM ranked r
WHERE ja.id=r.id AND r.rn=1
  AND NOT EXISTS (
      SELECT 1 FROM jellyfin_accounts already
      WHERE already.customer_id=ja.customer_id AND already.is_primary=TRUE
  );

CREATE UNIQUE INDEX IF NOT EXISTS jellyfin_accounts_one_primary_per_customer
    ON jellyfin_accounts(customer_id)
    WHERE is_primary=TRUE;

CREATE TABLE IF NOT EXISTS customer_server_migrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    source_account_id UUID NOT NULL REFERENCES jellyfin_accounts(id) ON DELETE RESTRICT,
    source_server_id UUID NOT NULL REFERENCES jellyfin_servers(id) ON DELETE RESTRICT,
    target_server_id UUID NOT NULL REFERENCES jellyfin_servers(id) ON DELETE RESTRICT,
    target_account_id UUID REFERENCES jellyfin_accounts(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','succeeded','failed','rolled_back','rollback_failed')),
    failure_stage TEXT,
    last_error TEXT,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    requested_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    rolled_back_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (source_server_id <> target_server_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_server_migrations_one_open_per_customer
    ON customer_server_migrations(customer_id)
    WHERE status IN ('pending','running');
CREATE INDEX IF NOT EXISTS customer_server_migrations_recent_idx
    ON customer_server_migrations(requested_at DESC);
CREATE INDEX IF NOT EXISTS customer_server_migrations_target_idx
    ON customer_server_migrations(target_server_id,status);

COMMIT;
