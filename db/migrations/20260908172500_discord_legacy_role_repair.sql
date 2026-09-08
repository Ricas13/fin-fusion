-- Re-run Discord reconciliation immediately after deploying the safer legacy
-- plan-role fallback. Existing linked customers may currently have an active
-- migrated plan whose direct discord_role_id is NULL; the application can now
-- resolve that role from a unanimous equivalent plan family when it is safe.
UPDATE automation_job_state
SET next_run_at = NOW(),
    force_run_requested = TRUE,
    updated_at = NOW()
WHERE job_key = 'discord_roles'
  AND enabled = TRUE;
