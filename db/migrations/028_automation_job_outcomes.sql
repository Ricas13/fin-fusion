ALTER TABLE automation_job_state
    ADD COLUMN IF NOT EXISTS last_completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_outcome TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS last_failed_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_warning TEXT;

UPDATE automation_job_state
SET last_completed_at = COALESCE(last_completed_at, last_success_at, last_started_at),
    last_outcome = CASE
        WHEN last_error IS NOT NULL THEN 'failed'
        WHEN last_success_at IS NOT NULL THEN 'success'
        ELSE COALESCE(NULLIF(last_outcome, ''), 'unknown')
    END,
    last_failed_count = CASE WHEN last_error IS NOT NULL THEN GREATEST(last_failed_count, 1) ELSE last_failed_count END;

ALTER TABLE automation_job_state
    DROP CONSTRAINT IF EXISTS automation_job_state_last_outcome_check;

ALTER TABLE automation_job_state
    ADD CONSTRAINT automation_job_state_last_outcome_check
    CHECK (last_outcome IN ('unknown','success','degraded','failed')),
    DROP CONSTRAINT IF EXISTS automation_job_state_last_failed_count_check;

ALTER TABLE automation_job_state
    ADD CONSTRAINT automation_job_state_last_failed_count_check
    CHECK (last_failed_count >= 0);
