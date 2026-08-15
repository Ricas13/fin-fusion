BEGIN;

CREATE TABLE IF NOT EXISTS backup_verification_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    backup_run_id UUID NOT NULL REFERENCES backup_runs(id) ON DELETE CASCADE,
    requested_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    worker_instance_id TEXT,
    error TEXT
);

CREATE INDEX IF NOT EXISTS backup_verification_requests_status_idx
    ON backup_verification_requests(status,requested_at);

CREATE UNIQUE INDEX IF NOT EXISTS backup_verification_requests_active_backup_idx
    ON backup_verification_requests(backup_run_id)
    WHERE status IN ('queued','running');

COMMIT;
