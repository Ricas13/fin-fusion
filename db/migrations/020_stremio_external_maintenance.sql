CREATE TABLE IF NOT EXISTS stremio_source_retired_tokens (
  id bigserial PRIMARY KEY,
  source_id uuid NOT NULL,
  base_url text NOT NULL,
  source_name text,
  token_encrypted text NOT NULL,
  revoke_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT NOW() NOT NULL,
  last_attempt_at timestamp with time zone,
  attempt_count integer DEFAULT 0 NOT NULL,
  last_error text
);

CREATE INDEX IF NOT EXISTS stremio_source_retired_tokens_due_idx
  ON stremio_source_retired_tokens(revoke_at,id);

COMMENT ON TABLE stremio_source_retired_tokens IS 'Encrypted retired external Jellyfin source tokens waiting for grace-period revocation.';

ALTER TABLE stremio_sources
  ALTER COLUMN token_rotation_hours SET DEFAULT 4;

UPDATE stremio_sources
SET token_rotation_hours=4,
    token_rotates_at=CASE
      WHEN token_rotation_enabled THEN LEAST(COALESCE(token_rotates_at,NOW()+INTERVAL '4 hours'),NOW()+INTERVAL '4 hours')
      ELSE token_rotates_at
    END,
    updated_at=NOW()
WHERE token_rotation_hours=12;

UPDATE stremio_source_index_state
SET next_incremental_at=LEAST(COALESCE(next_incremental_at,NOW()),NOW()+INTERVAL '3 hours'),
    updated_at=NOW();

INSERT INTO automation_job_state(job_key,enabled,interval_seconds,next_run_at)
VALUES('stremio_external_tokens',TRUE,300,NOW())
ON CONFLICT(job_key) DO UPDATE
SET enabled=TRUE,
    interval_seconds=300,
    next_run_at=LEAST(COALESCE(automation_job_state.next_run_at,NOW()),NOW()+INTERVAL '5 minutes'),
    updated_at=NOW();

INSERT INTO automation_job_state(job_key,enabled,interval_seconds,next_run_at)
VALUES('stremio_media_index',TRUE,10800,NOW())
ON CONFLICT(job_key) DO UPDATE
SET enabled=TRUE,
    interval_seconds=10800,
    next_run_at=LEAST(COALESCE(automation_job_state.next_run_at,NOW()),NOW()+INTERVAL '3 hours'),
    updated_at=NOW();
