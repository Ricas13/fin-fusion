BEGIN;

CREATE TABLE IF NOT EXISTS jellyfin_policy_drift (
    jellyfin_account_id UUID PRIMARY KEY REFERENCES jellyfin_accounts(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    server_id UUID NOT NULL REFERENCES jellyfin_servers(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','in_sync','drift','unreachable','missing')),
    desired_disabled BOOLEAN,
    desired_hash TEXT,
    remote_hash TEXT,
    differences JSONB NOT NULL DEFAULT '[]'::jsonb,
    last_checked_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_error TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS jellyfin_policy_drift_due_idx
    ON jellyfin_policy_drift(next_check_at,status);
CREATE INDEX IF NOT EXISTS jellyfin_policy_drift_status_idx
    ON jellyfin_policy_drift(status,updated_at DESC);
CREATE INDEX IF NOT EXISTS jellyfin_policy_drift_customer_idx
    ON jellyfin_policy_drift(customer_id);

COMMIT;
