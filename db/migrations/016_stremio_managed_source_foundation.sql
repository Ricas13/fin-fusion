BEGIN;

ALTER TABLE jellyfin_servers
    ADD COLUMN IF NOT EXISTS stremio_priority integer DEFAULT 100 NOT NULL;

ALTER TABLE jellyfin_servers
    DROP CONSTRAINT IF EXISTS jellyfin_servers_stremio_priority_check;

ALTER TABLE jellyfin_servers
    ADD CONSTRAINT jellyfin_servers_stremio_priority_check
    CHECK (stremio_priority BETWEEN 1 AND 10000);

CREATE TABLE IF NOT EXISTS stremio_managed_accounts (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    entitlement_id uuid NOT NULL REFERENCES stremio_entitlements(id) ON DELETE CASCADE,
    customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    server_id uuid NOT NULL REFERENCES jellyfin_servers(id) ON DELETE CASCADE,
    jellyfin_account_id uuid NOT NULL REFERENCES jellyfin_accounts(id) ON DELETE CASCADE,
    access_token_encrypted text NOT NULL,
    token_issued_at timestamp with time zone,
    status text DEFAULT 'active' NOT NULL,
    last_playback_info_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    UNIQUE(entitlement_id, server_id),
    CONSTRAINT stremio_managed_accounts_status_check CHECK (status IN ('active','suspended','error'))
);

CREATE INDEX IF NOT EXISTS stremio_managed_accounts_customer_idx
    ON stremio_managed_accounts(customer_id, status);
CREATE INDEX IF NOT EXISTS stremio_managed_accounts_server_idx
    ON stremio_managed_accounts(server_id, status);

-- Preserve the existing single-managed-server entitlement as the first member of
-- the new multi-server mapping. The legacy columns remain during the transition
-- so already-issued installations continue to work while runtime delivery moves
-- to the new model in the follow-up PR.
INSERT INTO stremio_managed_accounts(
    entitlement_id,customer_id,server_id,jellyfin_account_id,
    access_token_encrypted,token_issued_at,status
)
SELECT
    e.id,e.customer_id,e.server_id,e.jellyfin_account_id,
    e.jellyfin_access_token_encrypted,e.jellyfin_token_issued_at,
    CASE WHEN e.status='active' THEN 'active' ELSE 'suspended' END
FROM stremio_entitlements e
WHERE e.server_id IS NOT NULL
  AND e.jellyfin_account_id IS NOT NULL
  AND e.jellyfin_access_token_encrypted IS NOT NULL
ON CONFLICT(entitlement_id,server_id) DO NOTHING;

COMMIT;
