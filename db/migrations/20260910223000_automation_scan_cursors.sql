BEGIN;

CREATE TABLE IF NOT EXISTS automation_scan_cursors (
    scan_key TEXT PRIMARY KEY,
    cursor_text TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE automation_scan_cursors IS
    'Durable keyset cursors for bounded automation sweeps so large populations resume after restarts instead of rescanning from the beginning.';

COMMIT;
