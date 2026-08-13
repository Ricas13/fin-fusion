BEGIN;

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS phone TEXT,
    ADD COLUMN IF NOT EXISTS country_code CHAR(2),
    ADD COLUMN IF NOT EXISTS timezone TEXT,
    ADD COLUMN IF NOT EXISTS referral_source TEXT,
    ADD COLUMN IF NOT EXISTS registration_source TEXT,
    ADD COLUMN IF NOT EXISTS discord_user_id TEXT,
    ADD COLUMN IF NOT EXISTS discord_username TEXT,
    ADD COLUMN IF NOT EXISTS marketing_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS customers_discord_user_unique
    ON customers(discord_user_id)
    WHERE discord_user_id IS NOT NULL AND discord_user_id <> '';

CREATE TABLE IF NOT EXISTS customer_download_events (
    id BIGSERIAL PRIMARY KEY,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    jellyfin_account_id UUID REFERENCES jellyfin_accounts(id) ON DELETE SET NULL,
    server_id UUID REFERENCES jellyfin_servers(id) ON DELETE SET NULL,
    item_id TEXT,
    item_name TEXT,
    item_type TEXT,
    bytes BIGINT CHECK (bytes IS NULL OR bytes >= 0),
    client_name TEXT,
    device_name TEXT,
    source TEXT NOT NULL DEFAULT 'proxy' CHECK (source IN ('proxy','jellyfin','manual')),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS customer_download_events_customer_created_idx
    ON customer_download_events(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS customer_download_events_server_created_idx
    ON customer_download_events(server_id, created_at DESC);

COMMIT;
