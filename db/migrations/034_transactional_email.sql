BEGIN;

CREATE TABLE IF NOT EXISTS email_gateway_settings (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id=1),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    host TEXT,
    port INTEGER CHECK (port IS NULL OR (port BETWEEN 1 AND 65535)),
    secure_mode TEXT NOT NULL DEFAULT 'starttls' CHECK (secure_mode IN ('tls','starttls','plain')),
    username TEXT,
    password_encrypted TEXT,
    from_name TEXT,
    from_email TEXT,
    reply_to TEXT,
    updated_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel TEXT NOT NULL DEFAULT 'email' CHECK (channel='email'),
    message_type TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    payload_encrypted TEXT NOT NULL,
    dedupe_key TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_attempt_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notification_outbox_due_idx
    ON notification_outbox(next_attempt_at,created_at)
    WHERE status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS notification_outbox_recent_idx
    ON notification_outbox(created_at DESC);

COMMIT;
