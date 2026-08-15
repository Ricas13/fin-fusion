BEGIN;

ALTER TABLE subscriptions
    ADD COLUMN IF NOT EXISTS service_extension_days INTEGER NOT NULL DEFAULT 0;

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_service_extension_days_check;
ALTER TABLE subscriptions
    ADD CONSTRAINT subscriptions_service_extension_days_check
    CHECK (service_extension_days BETWEEN 0 AND 3650);

CREATE TABLE IF NOT EXISTS subscription_service_extension_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    days INTEGER NOT NULL CHECK (days > 0 AND days <= 365),
    reference_id TEXT,
    actor_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(source,reference_id)
);

CREATE INDEX IF NOT EXISTS subscription_service_extension_customer_idx
    ON subscription_service_extension_events(customer_id,created_at DESC);

COMMIT;
