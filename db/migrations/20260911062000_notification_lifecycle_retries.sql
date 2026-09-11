CREATE TABLE IF NOT EXISTS notification_lifecycle_retries (
    dedupe_key TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_attempt_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_lifecycle_retries_due
    ON notification_lifecycle_retries(next_attempt_at, created_at);
