BEGIN;

ALTER TABLE app_users
    ADD COLUMN IF NOT EXISTS legacy_numeric_id INTEGER,
    ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS totp_enrolled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS app_users_role_legacy_id_unique
    ON app_users(role, legacy_numeric_id)
    WHERE legacy_numeric_id IS NOT NULL AND role IN ('admin','reseller');

CREATE TABLE IF NOT EXISTS auth_totp_enrollments (
    user_id UUID PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
    secret_encrypted TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_recovery_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, code_hash)
);
CREATE INDEX IF NOT EXISTS auth_recovery_codes_active_idx
    ON auth_recovery_codes(user_id)
    WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_sessions (
    session_id TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin','reseller','customer')),
    session_version INTEGER NOT NULL,
    ip_encrypted TEXT,
    user_agent_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_active_idx
    ON auth_sessions(user_id, last_seen_at DESC)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_events (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    identity_hint TEXT,
    event_type TEXT NOT NULL,
    success BOOLEAN NOT NULL DEFAULT FALSE,
    ip_encrypted TEXT,
    user_agent_hash TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS auth_events_user_created_idx
    ON auth_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS auth_events_type_created_idx
    ON auth_events(event_type, created_at DESC);

UPDATE app_users
SET password_changed_at = COALESCE(password_changed_at, updated_at, created_at)
WHERE password_changed_at IS NULL;

COMMIT;
