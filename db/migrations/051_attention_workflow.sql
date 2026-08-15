BEGIN;

CREATE TABLE IF NOT EXISTS attention_workflow (
    fingerprint TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('critical','warning','info')),
    title TEXT NOT NULL,
    href TEXT,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cleared_at TIMESTAMPTZ,
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    assigned_to UUID REFERENCES app_users(id) ON DELETE SET NULL,
    note TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS attention_workflow_open_idx ON attention_workflow(cleared_at,severity,last_seen_at DESC);
CREATE INDEX IF NOT EXISTS attention_workflow_assignee_idx ON attention_workflow(assigned_to) WHERE cleared_at IS NULL;

COMMIT;
