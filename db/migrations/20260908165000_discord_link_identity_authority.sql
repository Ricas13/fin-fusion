-- Discord OAuth is the identity source of truth. Keep legacy customer columns
-- synchronized for older admin/reporting code, then immediately reconcile all
-- linked customers so existing missed role assignments self-heal on deploy.

UPDATE customers c
SET discord_user_id = prefs.discord_user_id,
    discord_username = prefs.discord_handle,
    updated_at = NOW()
FROM customer_communication_preferences prefs
WHERE prefs.customer_id = c.id
  AND prefs.discord_user_id IS NOT NULL
  AND prefs.discord_user_id <> ''
  AND (
      c.discord_user_id IS DISTINCT FROM prefs.discord_user_id
      OR c.discord_username IS DISTINCT FROM prefs.discord_handle
  );

UPDATE automation_job_state
SET next_run_at = NOW(),
    force_run_requested = TRUE,
    updated_at = NOW()
WHERE job_key = 'discord_roles'
  AND enabled = TRUE;
