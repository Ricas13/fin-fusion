BEGIN;

CREATE TABLE IF NOT EXISTS active_playback_sessions (
    server_id UUID NOT NULL REFERENCES jellyfin_servers(id) ON DELETE CASCADE,
    jellyfin_session_id TEXT NOT NULL,
    playback_key TEXT NOT NULL,
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    jellyfin_account_id UUID REFERENCES jellyfin_accounts(id) ON DELETE CASCADE,
    jellyfin_user_id TEXT,
    play_session_id TEXT,
    item_id TEXT,
    item_name TEXT,
    item_type TEXT,
    client_name TEXT,
    device_name TEXT,
    application_version TEXT,
    remote_endpoint_encrypted TEXT,
    playback_method TEXT NOT NULL DEFAULT 'unknown' CHECK (playback_method IN ('directplay','directstream','transcode','unknown')),
    transcode_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_paused BOOLEAN NOT NULL DEFAULT FALSE,
    position_ticks BIGINT,
    last_activity_at TIMESTAMPTZ,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    stream_limit INTEGER,
    over_limit_confirmations INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (server_id, jellyfin_session_id)
);

CREATE INDEX IF NOT EXISTS active_playback_customer_idx
    ON active_playback_sessions(customer_id);

CREATE TABLE IF NOT EXISTS playback_history (
    id BIGSERIAL PRIMARY KEY,
    server_id UUID NOT NULL REFERENCES jellyfin_servers(id) ON DELETE CASCADE,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    jellyfin_account_id UUID REFERENCES jellyfin_accounts(id) ON DELETE SET NULL,
    playback_key TEXT NOT NULL,
    jellyfin_session_id TEXT NOT NULL,
    item_id TEXT,
    item_name TEXT,
    item_type TEXT,
    client_name TEXT,
    device_name TEXT,
    playback_method TEXT NOT NULL DEFAULT 'unknown' CHECK (playback_method IN ('directplay','directstream','transcode','unknown')),
    transcode_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    started_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    ended_reason TEXT,
    UNIQUE(server_id, playback_key)
);

CREATE INDEX IF NOT EXISTS playback_history_customer_started_idx
    ON playback_history(customer_id, started_at DESC);

CREATE TABLE IF NOT EXISTS stream_policy_events (
    id BIGSERIAL PRIMARY KEY,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    server_id UUID REFERENCES jellyfin_servers(id) ON DELETE SET NULL,
    jellyfin_account_id UUID REFERENCES jellyfin_accounts(id) ON DELETE SET NULL,
    jellyfin_session_id TEXT,
    mode TEXT NOT NULL CHECK (mode IN ('observe','enforce')),
    decision TEXT NOT NULL CHECK (decision IN ('observed','pending','would_stop','stopped','stop_failed','skipped_safety')),
    stream_count INTEGER,
    stream_limit INTEGER,
    reason TEXT NOT NULL,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS stream_policy_events_customer_created_idx
    ON stream_policy_events(customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS stream_policy_events_decision_created_idx
    ON stream_policy_events(decision, created_at DESC);

COMMIT;
