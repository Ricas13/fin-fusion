ALTER TABLE app_users
    ADD COLUMN IF NOT EXISTS is_owner BOOLEAN NOT NULL DEFAULT FALSE;

-- Preserve the authority of every administrator that existed before this
-- capability split. New administrator rows default to support-only unless the
-- creation path explicitly promotes them to owner.
UPDATE app_users
SET is_owner=TRUE,
    updated_at=NOW()
WHERE role='admin'
  AND is_owner=FALSE;

CREATE INDEX IF NOT EXISTS idx_app_users_admin_owner
    ON app_users(is_owner)
    WHERE role='admin' AND active=TRUE;
