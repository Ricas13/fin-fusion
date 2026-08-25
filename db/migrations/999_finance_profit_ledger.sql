BEGIN;

CREATE TABLE IF NOT EXISTS finance_expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    series_id UUID NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL,
    vendor TEXT,
    category TEXT NOT NULL DEFAULT 'software',
    amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
    currency VARCHAR(3) NOT NULL,
    cadence TEXT NOT NULL CHECK (cadence IN ('monthly','quarterly','six_monthly','yearly')),
    effective_from DATE NOT NULL,
    effective_until DATE,
    next_renewal_date DATE,
    auto_renews BOOLEAN NOT NULL DEFAULT TRUE,
    reminder_days INTEGER NOT NULL DEFAULT 30 CHECK (reminder_days >= 0 AND reminder_days <= 365),
    notes TEXT,
    created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT finance_expenses_effective_window CHECK (effective_until IS NULL OR effective_until > effective_from),
    CONSTRAINT finance_expenses_series_version_unique UNIQUE (series_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS finance_expenses_open_series_idx
    ON finance_expenses(series_id)
    WHERE effective_until IS NULL;

CREATE INDEX IF NOT EXISTS finance_expenses_active_window_idx
    ON finance_expenses(effective_from, effective_until);

CREATE INDEX IF NOT EXISTS finance_expenses_renewal_idx
    ON finance_expenses(next_renewal_date)
    WHERE effective_until IS NULL AND next_renewal_date IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_financials (
    provider TEXT NOT NULL CHECK (provider IN ('stripe','paypal','plisio')),
    provider_event_id TEXT NOT NULL,
    event_type TEXT,
    gross_minor BIGINT,
    fee_minor BIGINT,
    net_minor BIGINT,
    currency VARCHAR(3),
    fee_source TEXT NOT NULL DEFAULT 'unavailable' CHECK (fee_source IN ('provider_actual','derived','unavailable')),
    provider_reference TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS payment_financials_created_idx
    ON payment_financials(created_at DESC);

COMMIT;
