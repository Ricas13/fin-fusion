-- Library/folder choices are no longer part of access-consistency drift.
-- Clear stale cached differences from the old comparison contract and queue
-- every managed Jellyfin account for a fresh read-only audit immediately.
UPDATE jellyfin_policy_drift
SET status = 'unknown',
    differences = '[]'::jsonb,
    desired_hash = NULL,
    remote_hash = NULL,
    last_error = NULL,
    consecutive_failures = 0,
    next_check_at = NOW(),
    updated_at = NOW();
