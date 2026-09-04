BEGIN;

CREATE TABLE IF NOT EXISTS jellyfin_account_creation_intents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    server_id UUID NOT NULL REFERENCES jellyfin_servers(id) ON DELETE CASCADE,
    username VARCHAR(80) NOT NULL,
    require_exact_username BOOLEAN NOT NULL DEFAULT FALSE,
    status VARCHAR(24) NOT NULL DEFAULT 'prepared'
        CHECK (status IN ('prepared','attempting','uncertain','remote_created')),
    remote_user_id TEXT,
    attempted_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(customer_id,server_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS jellyfin_account_creation_intents_server_username_uq
    ON jellyfin_account_creation_intents(server_id,LOWER(username));

CREATE INDEX IF NOT EXISTS jellyfin_account_creation_intents_status_idx
    ON jellyfin_account_creation_intents(status,updated_at);

COMMIT;
