BEGIN;

-- Customer-level provisioning state. This complements the per-Jellyfin-account
-- reconciliation row and gives the platform somewhere to represent states that
-- exist before an account can be created at all (for example, an active plan
-- with no eligible Jellyfin server configured yet).
CREATE TABLE IF NOT EXISTS customer_provisioning_state (
    customer_id UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','healthy','blocked','failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_attempt_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ,
    subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
    plan_id UUID REFERENCES plans(id) ON DELETE SET NULL,
    jellyfin_account_id UUID REFERENCES jellyfin_accounts(id) ON DELETE SET NULL,
    server_id UUID REFERENCES jellyfin_servers(id) ON DELETE SET NULL,
    last_result JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS customer_provisioning_state_due_idx
    ON customer_provisioning_state(next_attempt_at, status);
CREATE INDEX IF NOT EXISTS customer_provisioning_state_status_idx
    ON customer_provisioning_state(status, updated_at DESC);

-- The account-level table already has applied_policy_hash. Extend it so a
-- successful desired policy can be verified periodically without writing the
-- same policy to Jellyfin on every entitlement sweep.
ALTER TABLE jellyfin_policy_reconciliation
    ADD COLUMN IF NOT EXISTS desired_policy_hash TEXT,
    ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS drift_detected_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS jellyfin_policy_reconciliation_retry_idx
    ON jellyfin_policy_reconciliation(next_retry_at, status)
    WHERE status='failed';

COMMIT;
