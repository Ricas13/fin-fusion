BEGIN;

CREATE TABLE IF NOT EXISTS business_expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
    supplier TEXT,
    category TEXT NOT NULL DEFAULT 'Other' CHECK (length(btrim(category)) BETWEEN 1 AND 80),
    amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
    currency TEXT NOT NULL DEFAULT 'GBP' CHECK (currency ~ '^[A-Z]{3}$'),
    recurrence TEXT NOT NULL DEFAULT 'one_time' CHECK (recurrence IN ('one_time','monthly','quarterly','yearly')),
    start_date DATE NOT NULL,
    end_date DATE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    reference TEXT,
    notes TEXT,
    created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS business_expenses_start_date_idx ON business_expenses(start_date DESC);
CREATE INDEX IF NOT EXISTS business_expenses_active_recurrence_idx ON business_expenses(active, recurrence, start_date);
CREATE INDEX IF NOT EXISTS business_expenses_category_idx ON business_expenses(category);

COMMIT;
