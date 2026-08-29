BEGIN;

ALTER TABLE provider_operations
    ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_observed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS failure_kind TEXT,
    ADD COLUMN IF NOT EXISTS manual_review_required BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE provider_operations
    DROP CONSTRAINT IF EXISTS provider_operations_failure_kind_check;
ALTER TABLE provider_operations
    ADD CONSTRAINT provider_operations_failure_kind_check
    CHECK (failure_kind IS NULL OR failure_kind IN ('retryable','ambiguous','terminal','superseded'));

CREATE INDEX IF NOT EXISTS provider_operations_recovery_due_idx
    ON provider_operations(next_attempt_at,created_at)
    WHERE state IN ('planned','provider_applied','failed')
      AND manual_review_required=FALSE
      AND COALESCE(failure_kind,'') NOT IN ('terminal','superseded');

COMMIT;
