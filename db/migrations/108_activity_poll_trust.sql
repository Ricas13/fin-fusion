BEGIN;

CREATE TABLE IF NOT EXISTS jellyfin_activity_poll_state (
    server_id uuid PRIMARY KEY REFERENCES jellyfin_servers(id) ON DELETE CASCADE,
    last_attempt_at timestamp with time zone NOT NULL,
    last_success_at timestamp with time zone,
    last_failure_at timestamp with time zone,
    last_error text,
    updated_at timestamp with time zone NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS jellyfin_activity_poll_state_success_idx
    ON jellyfin_activity_poll_state(last_success_at DESC);

COMMIT;
