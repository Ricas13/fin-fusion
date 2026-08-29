BEGIN;

-- Deletion jobs created before recurring billing became a durable cleanup
-- target must be re-inventoried by the new worker before finalization.
UPDATE public.customer_deletion_jobs
SET targets_persisted_at=NULL,
    updated_at=NOW()
WHERE status IN ('pending','running','failed');

-- Older request-service cleanup could mark an unresolved identity as
-- already_missing without proving that a previously-provisioned account had
-- actually disappeared. Re-open only those ambiguous in-flight results so the
-- upgraded resolver can verify them again while customer identity still exists.
UPDATE public.customer_external_deletion_targets t
SET state='pending',
    result=NULL,
    completed_at=NULL,
    last_error='Re-verification required after request-service deletion safety upgrade.',
    next_attempt_at=NOW(),
    updated_at=NOW()
FROM public.customer_deletion_jobs j
WHERE t.deletion_job_id=j.id
  AND j.status IN ('pending','running','failed')
  AND t.provider='request_service'
  AND t.resource_type='permissions'
  AND t.state='succeeded'
  AND COALESCE(t.result->>'status','')='already_missing'
  AND NOT (t.metadata ? 'everProvisioned');

COMMIT;
