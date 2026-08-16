BEGIN;

-- Long-running runtime roles intentionally have no DDL privileges. Keep the
-- connect-pg-simple store under migration ownership rather than relying on the
-- web process to create infrastructure on first request.
CREATE TABLE IF NOT EXISTS user_sessions (
    sid VARCHAR NOT NULL COLLATE "default",
    sess JSON NOT NULL,
    expire TIMESTAMP(6) NOT NULL,
    CONSTRAINT user_sessions_pkey PRIMARY KEY (sid)
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_expire
    ON user_sessions(expire);

COMMIT;
