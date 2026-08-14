BEGIN;

CREATE TABLE IF NOT EXISTS subscription_provider_sync (
    subscription_id UUID PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('stripe','paypal')),
    remote_status TEXT,
    remote_period_end TIMESTAMPTZ,
    remote_cancel_at_period_end BOOLEAN,
    last_attempt_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_error TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS subscription_provider_sync_due_idx
    ON subscription_provider_sync(next_attempt_at)
    WHERE last_error IS NOT NULL OR next_attempt_at IS NOT NULL;

COMMIT;
