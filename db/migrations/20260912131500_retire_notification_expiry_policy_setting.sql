-- Expiry reminders are now a code-owned invariant: 3 days and final 24 hours.
-- Remove the old configurable platform setting so stale values cannot influence
-- behavior after deployment. Historical audit_log rows are retained as audit history.
DELETE FROM platform_settings
WHERE setting_key = 'notification_expiry_policy_v1';
