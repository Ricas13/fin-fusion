BEGIN;

CREATE TABLE IF NOT EXISTS backup_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    backup_type TEXT NOT NULL DEFAULT 'database' CHECK (backup_type IN ('database')),
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','deleted')),
    file_name TEXT,
    file_path TEXT,
    size_bytes BIGINT,
    checksum_sha256 TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    verified_at TIMESTAMPTZ,
    verification_note TEXT,
    error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS backup_runs_started_idx ON backup_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS backup_runs_status_idx ON backup_runs(status,started_at DESC);

CREATE TABLE IF NOT EXISTS backup_worker_state (
    worker_key TEXT PRIMARY KEY DEFAULT 'database_backup',
    instance_id TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_attempt_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_error TEXT,
    next_run_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO platform_settings(setting_key,setting_value)
VALUES ('backup_policy_v1', jsonb_build_object(
    'enabled', true,
    'intervalHours', 24,
    'retentionDays', 30,
    'minimumCopies', 7
)) ON CONFLICT(setting_key) DO NOTHING;

INSERT INTO platform_settings(setting_key,setting_value)
VALUES ('support_links_v1', jsonb_build_object(
    'supportEmail','',
    'supportUrl','',
    'termsUrl','',
    'privacyUrl','',
    'refundUrl','',
    'statusUrl',''
)) ON CONFLICT(setting_key) DO NOTHING;

COMMIT;
