BEGIN;

CREATE TABLE IF NOT EXISTS payment_provider_credentials (
    provider TEXT PRIMARY KEY CHECK (provider IN ('stripe','paypal')),
    secrets_encrypted TEXT NOT NULL,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A plan/provider can now expose both one-time and recurring checkout.
ALTER TABLE plan_provider_prices
    DROP CONSTRAINT IF EXISTS plan_provider_prices_plan_id_provider_key;

ALTER TABLE plan_provider_prices
    ALTER COLUMN external_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS plan_provider_prices_plan_provider_mode_unique
    ON plan_provider_prices(plan_id, provider, checkout_mode);

COMMIT;
