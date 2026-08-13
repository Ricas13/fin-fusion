BEGIN;

ALTER TABLE app_users
    ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS customers_user_unique
    ON customers(user_id)
    WHERE user_id IS NOT NULL;

ALTER TABLE plans
    ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS visible BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 100,
    ADD COLUMN IF NOT EXISTS allow_4k BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE jellyfin_servers
    ADD COLUMN IF NOT EXISTS location TEXT,
    ADD COLUMN IF NOT EXISTS allow_new_users BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS trial_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS paid_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE jellyfin_accounts
    ADD COLUMN IF NOT EXISTS last_policy_sync TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS plan_provider_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('stripe','paypal')),
    external_id TEXT NOT NULL,
    checkout_mode TEXT NOT NULL CHECK (checkout_mode IN ('payment','subscription')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(plan_id, provider),
    UNIQUE(provider, external_id)
);

CREATE TABLE IF NOT EXISTS payment_customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('stripe','paypal')),
    provider_customer_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(customer_id, provider),
    UNIQUE(provider, provider_customer_id)
);

CREATE TABLE IF NOT EXISTS account_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    token_type TEXT NOT NULL CHECK (token_type IN ('email_verify','password_reset')),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS account_tokens_lookup_idx
    ON account_tokens(token_type, token_hash)
    WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS provisioning_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
    action TEXT NOT NULL CHECK (action IN ('provision','reconcile','disable','password_reset')),
    status TEXT NOT NULL CHECK (status IN ('started','succeeded','failed')),
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS provisioning_runs_customer_idx ON provisioning_runs(customer_id, started_at DESC);

CREATE INDEX IF NOT EXISTS subscriptions_entitlement_idx
    ON subscriptions(customer_id, current_period_end DESC)
    WHERE status IN ('active','trialing','past_due');

UPDATE plans SET description='24-hour trial with one concurrent stream', sort_order=10 WHERE code='trial-24h';
UPDATE plans SET description='Monthly access with up to three concurrent streams and downloads', sort_order=20 WHERE code='monthly';
UPDATE plans SET description='Six months access with up to three concurrent streams and downloads', sort_order=30 WHERE code='six-month';
UPDATE plans SET description='Yearly access with up to three concurrent streams and downloads', sort_order=40 WHERE code='yearly';

COMMIT;
