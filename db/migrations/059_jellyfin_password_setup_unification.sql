BEGIN;

-- Migration 026 introduced password_reset_required for controlled server
-- moves. The customer credential handoff now uses the clearer canonical
-- password_setup_required flag. Preserve already-pending migration prompts on
-- upgrades without dropping the legacy column, which may still exist on older
-- installations until a later compatibility cleanup.
UPDATE jellyfin_accounts
SET password_setup_required=TRUE,
    updated_at=NOW()
WHERE password_reset_required=TRUE
  AND password_setup_required=FALSE;

COMMIT;
