BEGIN;

CREATE TABLE IF NOT EXISTS reseller_tiers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    monthly_price_minor INTEGER NOT NULL CHECK (monthly_price_minor >= 0),
    currency CHAR(3) NOT NULL DEFAULT 'GBP',
    seat_limit INTEGER NOT NULL CHECK (seat_limit BETWEEN 1 AND 100000),
    visible BOOLEAN NOT NULL DEFAULT TRUE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reseller_tier_provider_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tier_id UUID NOT NULL REFERENCES reseller_tiers(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('stripe','paypal')),
    external_id TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tier_id, provider),
    UNIQUE(provider, external_id)
);

CREATE TABLE IF NOT EXISTS reseller_payment_customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reseller_id UUID NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('stripe','paypal')),
    provider_customer_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(reseller_id, provider),
    UNIQUE(provider, provider_customer_id)
);

CREATE TABLE IF NOT EXISTS reseller_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reseller_id UUID NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
    tier_id UUID NOT NULL REFERENCES reseller_tiers(id) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (status IN ('pending','active','past_due','cancelled','expired')),
    source TEXT NOT NULL CHECK (source IN ('manual','stripe','paypal')),
    starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    current_period_end TIMESTAMPTZ NOT NULL,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
    provider_customer_id TEXT,
    provider_subscription_id TEXT,
    provider_status TEXT,
    last_provider_sync_at TIMESTAMPTZ,
    last_provider_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS reseller_subscriptions_provider_unique
    ON reseller_subscriptions(source, provider_subscription_id)
    WHERE provider_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS reseller_subscriptions_reseller_idx
    ON reseller_subscriptions(reseller_id, current_period_end DESC);
CREATE INDEX IF NOT EXISTS reseller_subscriptions_due_idx
    ON reseller_subscriptions(status, current_period_end);

CREATE TABLE IF NOT EXISTS reseller_sales (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reseller_id UUID NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    plan_id UUID REFERENCES plans(id) ON DELETE SET NULL,
    amount_minor INTEGER NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
    currency CHAR(3) NOT NULL DEFAULT 'GBP',
    payment_method TEXT NOT NULL DEFAULT 'other',
    service_starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    service_ends_at TIMESTAMPTZ,
    note TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS reseller_sales_reseller_date_idx
    ON reseller_sales(reseller_id, created_at DESC);

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS is_reseller_owner BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS customers_one_reseller_owner_idx
    ON customers(reseller_id)
    WHERE is_reseller_owner=TRUE AND reseller_id IS NOT NULL;

ALTER TABLE resellers
    ADD COLUMN IF NOT EXISTS own_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS estate_suspended_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS estate_suspend_reason TEXT;

-- Cancelling renewal must not revoke a period that has already been paid for.
-- Provider adapters may report "cancelled" immediately; while the paid-through
-- timestamp is still in the future, keep the internal entitlement active and
-- remember that it must stop at period end.
CREATE OR REPLACE FUNCTION normalize_reseller_paid_through_status()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status='cancelled' AND NEW.cancel_at_period_end=TRUE AND NEW.current_period_end>NOW() THEN
        NEW.status := 'active';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS reseller_paid_through_status_trigger ON reseller_subscriptions;
CREATE TRIGGER reseller_paid_through_status_trigger
BEFORE INSERT OR UPDATE OF status,cancel_at_period_end,current_period_end
ON reseller_subscriptions
FOR EACH ROW EXECUTE FUNCTION normalize_reseller_paid_through_status();

-- "Active" controls availability to new resellers. Existing paid subscribers
-- are grandfathered: an administrator cannot archive a tier while a live paid
-- subscription still depends on it.
CREATE OR REPLACE FUNCTION protect_live_reseller_tier()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.active=TRUE AND NEW.active=FALSE AND EXISTS (
        SELECT 1 FROM reseller_subscriptions rs
        WHERE rs.tier_id=OLD.id AND rs.status='active' AND rs.current_period_end>NOW()
    ) THEN
        RAISE EXCEPTION 'Cannot archive reseller tier while active subscriptions still use it';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS protect_live_reseller_tier_trigger ON reseller_tiers;
CREATE TRIGGER protect_live_reseller_tier_trigger
BEFORE UPDATE OF active ON reseller_tiers
FOR EACH ROW EXECUTE FUNCTION protect_live_reseller_tier();

COMMIT;
