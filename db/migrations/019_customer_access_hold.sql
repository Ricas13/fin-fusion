BEGIN;

-- A persistent, reversible "access hold" independent of subscription billing
-- status. Bulk disable/suspend must not use subscription cancellation --
-- cancellation is a hard-to-reverse billing action, not a togglable access
-- switch, and there was no reliable way for "enable" to know what status to
-- resume to. This also fixes disable being non-persistent: disabling
-- Jellyfin accounts directly (without recording a hold) meant the periodic
-- entitlement-reconcile sweep would silently re-enable them on its next
-- pass, since it only ever looks at subscription state.
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS access_paused_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS access_hold_reason TEXT;

COMMIT;
