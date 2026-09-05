BEGIN;

-- Jellyfin customer identities have a binary lifecycle: if the account exists,
-- it is enabled. Access loss is represented by deleting the remote/local
-- account, never by persisting a disabled account.

-- Migration history must not pin a live account row forever. Preserve the
-- historical server/account metadata on customer_server_migrations while
-- allowing the source account row to be removed.
ALTER TABLE customer_server_migrations
    ALTER COLUMN source_account_id DROP NOT NULL;

ALTER TABLE customer_server_migrations
    DROP CONSTRAINT IF EXISTS customer_server_migrations_source_account_id_fkey;

ALTER TABLE customer_server_migrations
    ADD CONSTRAINT customer_server_migrations_source_account_id_fkey
    FOREIGN KEY (source_account_id)
    REFERENCES jellyfin_accounts(id)
    ON DELETE SET NULL;

-- Every legacy disabled identity is reconciled immediately after deployment.
-- Valid entitlement/activity will force an enabled policy; invalid access will
-- remove the identity. This also catches managed Stremio internal identities.
INSERT INTO customer_provisioning_state(customer_id,status,next_attempt_at,updated_at)
SELECT DISTINCT customer_id,'pending',NOW(),NOW()
FROM jellyfin_accounts
WHERE disabled=TRUE
ON CONFLICT(customer_id) DO UPDATE SET
    status='pending',
    next_attempt_at=NOW(),
    updated_at=NOW();

-- Existing disabled rows are legacy state. Mark them enabled locally so the
-- database can adopt the new invariant before the queued remote reconciliation.
UPDATE jellyfin_accounts
SET disabled=FALSE,
    updated_at=NOW()
WHERE disabled=TRUE;

ALTER TABLE jellyfin_accounts
    DROP CONSTRAINT IF EXISTS jellyfin_accounts_never_disabled;

ALTER TABLE jellyfin_accounts
    ADD CONSTRAINT jellyfin_accounts_never_disabled
    CHECK (disabled=FALSE);

-- Reconciliation may retain this compatibility column for old readers, but a
-- desired disabled policy is no longer a valid target state.
UPDATE jellyfin_policy_reconciliation
SET desired_disabled=FALSE
WHERE desired_disabled=TRUE;

ALTER TABLE jellyfin_policy_reconciliation
    DROP CONSTRAINT IF EXISTS jellyfin_policy_reconciliation_never_disabled;

ALTER TABLE jellyfin_policy_reconciliation
    ADD CONSTRAINT jellyfin_policy_reconciliation_never_disabled
    CHECK (desired_disabled IS DISTINCT FROM TRUE);

-- The old Free lifecycle used a pending disabled-account ledger. Close any
-- unfinished rows as historical records; current Free enforcement removes the
-- account immediately once its activity policy is breached.
UPDATE jellyfin_account_lifecycle
SET restored_at=COALESCE(restored_at,NOW()),
    metadata=COALESCE(metadata,'{}'::jsonb) || jsonb_build_object(
        'retiredByBinaryLifecycle',TRUE,
        'retiredAt',NOW()
    ),
    updated_at=NOW()
WHERE deleted_at IS NULL
  AND restored_at IS NULL;

COMMIT;
