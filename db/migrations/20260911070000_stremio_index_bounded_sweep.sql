BEGIN;

-- External Stremio media indexes can be large. The worker now processes one
-- source per pass, so installations that were still using the historical
-- three-hour default need a shorter scheduler cadence to drain a due backlog.
-- Preserve any operator-customised interval by changing only the exact old
-- default value.
UPDATE public.automation_job_state
SET interval_seconds=300,
    next_run_at=LEAST(COALESCE(next_run_at,NOW()),NOW()+INTERVAL '5 minutes'),
    updated_at=NOW()
WHERE job_key='stremio_media_index'
  AND interval_seconds=10800;

COMMIT;
