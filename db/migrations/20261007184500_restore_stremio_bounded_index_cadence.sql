BEGIN;

-- The bounded external-index sweep deliberately moved this job from the old
-- three-hour monolithic cadence to a five-minute dispatcher. Later admin
-- queue/rebuild code accidentally wrote 10800 back into automation_job_state.
-- Repair only that retired default value so operator-customized intervals are
-- preserved.
UPDATE public.automation_job_state
SET interval_seconds=300,
    next_run_at=LEAST(COALESCE(next_run_at,NOW()),NOW()+INTERVAL '5 minutes'),
    updated_at=NOW()
WHERE job_key='stremio_media_index'
  AND interval_seconds=10800;

COMMIT;
