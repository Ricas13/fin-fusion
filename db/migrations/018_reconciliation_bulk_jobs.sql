BEGIN;

-- Tracks the CURRENT reconciliation state of each Jellyfin account's policy,
-- separate from provisioning_runs (which is an append-only history log of
-- every attempt). One row per account so admins/bulk jobs can see "is this
-- account's policy up to date right now" without scanning history, and so
-- retries have somewhere to accumulate attempt_count/last_error.
CREATE TABLE IF NOT EXISTS jellyfin_policy_reconciliation (
    jellyfin_account_id UUID PRIMARY KEY REFERENCES jellyfin_accounts(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','successful','failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_attempt_at TIMESTAMPTZ,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    applied_policy_hash TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS jellyfin_policy_reconciliation_status_idx
    ON jellyfin_policy_reconciliation(status, requested_at);
CREATE INDEX IF NOT EXISTS jellyfin_policy_reconciliation_customer_idx
    ON jellyfin_policy_reconciliation(customer_id);

-- Generic bulk-job framework, reused for both admin-initiated bulk customer
-- operations and plan-change reconciliation fanout. A job is scoped to the
-- reseller who may retry/view it (NULL = an admin-scoped job); every
-- read/retry endpoint must re-check this against the caller, never trust a
-- client-supplied job id alone as proof of ownership.
CREATE TABLE IF NOT EXISTS background_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','completed_with_errors','failed','cancelled')),
    created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    reseller_scope UUID REFERENCES resellers(id) ON DELETE SET NULL,
    idempotency_key TEXT,
    params JSONB NOT NULL DEFAULT '{}'::jsonb,
    total_items INTEGER NOT NULL DEFAULT 0,
    succeeded_items INTEGER NOT NULL DEFAULT 0,
    failed_items INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS background_jobs_idempotency_unique
    ON background_jobs(created_by, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS background_jobs_status_idx
    ON background_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS background_jobs_created_by_idx
    ON background_jobs(created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS background_jobs_reseller_scope_idx
    ON background_jobs(reseller_scope, created_at DESC);

-- Per-target result row. UNIQUE(job_id,customer_id) makes re-enqueueing the
-- same job idempotent at the schema level, and status transitions are the
-- only thing "retry failed items" is allowed to touch -- a succeeded item is
-- never revisited by a retry pass.
CREATE TABLE IF NOT EXISTS background_job_items (
    id BIGSERIAL PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES background_jobs(id) ON DELETE CASCADE,
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed','skipped')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    previous_state JSONB,
    result JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(job_id, customer_id)
);
CREATE INDEX IF NOT EXISTS background_job_items_job_status_idx
    ON background_job_items(job_id, status);
-- The worker only ever auto-claims 'pending' items; 'failed' items require an
-- explicit admin retry action (which resets them back to 'pending') so a
-- transient failure can never silently keep retrying unbounded on its own.
CREATE INDEX IF NOT EXISTS background_job_items_pending_idx
    ON background_job_items(status, id)
    WHERE status = 'pending';

COMMIT;
