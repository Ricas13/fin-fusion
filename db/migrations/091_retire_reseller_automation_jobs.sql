BEGIN;

-- The reseller product is retired. Preserve historical reseller data, but
-- remove its scheduler state so the supported automation UI and worker cannot
-- continue or re-enable reseller billing/estate/notification processing.
DELETE FROM automation_job_state
WHERE job_key IN ('reseller_billing','reseller_estates','reseller_notifications');

COMMIT;
