BEGIN;

DELETE FROM public.automation_job_state
WHERE job_key='marketing_campaigns';

COMMIT;
