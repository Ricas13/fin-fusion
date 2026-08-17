BEGIN;

ALTER TABLE customer_communication_preferences
    ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT,
    ADD COLUMN IF NOT EXISTS telegram_linked_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS discord_user_id TEXT,
    ADD COLUMN IF NOT EXISTS discord_linked_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS whatsapp_opted_in_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS customer_comm_telegram_chat_unique
    ON customer_communication_preferences(telegram_chat_id)
    WHERE telegram_chat_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customer_comm_discord_user_unique
    ON customer_communication_preferences(discord_user_id)
    WHERE discord_user_id IS NOT NULL;

UPDATE customer_communication_preferences
SET whatsapp_opted_in_at=COALESCE(whatsapp_opted_in_at,updated_at,NOW())
WHERE whatsapp_opt_in=TRUE AND phone_e164 IS NOT NULL;

CREATE TABLE IF NOT EXISTS customer_channel_link_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK(channel IN ('telegram','discord')),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS customer_channel_link_tokens_lookup_idx
    ON customer_channel_link_tokens(channel,token_hash,expires_at)
    WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS customer_channel_link_tokens_customer_idx
    ON customer_channel_link_tokens(customer_id,channel,created_at DESC);

COMMENT ON COLUMN customer_communication_preferences.telegram_chat_id IS
'Verified private Telegram chat id obtained when the customer starts the CAPTAiNFiN bot with a one-time link token.';
COMMENT ON COLUMN customer_communication_preferences.discord_user_id IS
'Verified immutable Discord user snowflake obtained through Discord OAuth identify.';
COMMENT ON TABLE customer_channel_link_tokens IS
'Short-lived one-time tokens used to bind a signed-in CAPTAiNFiN customer to Telegram or Discord without trusting typed handles as delivery addresses.';

COMMIT;
