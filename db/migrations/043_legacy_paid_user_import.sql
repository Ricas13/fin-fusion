-- Audited bridge from trusted legacy portal exports into local customer access.
-- This is deliberately separate from payment_history_transactions: historical
-- accounting rows are never entitlement-authoritative, while rows recorded
-- here represent an administrator-confirmed legacy subscription contract.

CREATE TABLE IF NOT EXISTS legacy_subscription_imports (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    source_system text NOT NULL DEFAULT 'legacy_csv',
    provider text NOT NULL CHECK (provider IN ('stripe','paypal','manual')),
    provider_transaction_id text NOT NULL,
    legacy_payment_id text,
    legacy_user_id text,
    email text NOT NULL,
    legacy_plan_name text NOT NULL,
    plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
    customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    amount_minor integer NOT NULL CHECK (amount_minor >= 0),
    currency char(3) NOT NULL,
    period_start timestamptz NOT NULL,
    period_end timestamptz NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    requested_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (period_end > period_start),
    UNIQUE(source_system, provider, provider_transaction_id)
);

CREATE INDEX IF NOT EXISTS legacy_subscription_imports_customer_idx
    ON legacy_subscription_imports(customer_id, period_end DESC);
CREATE INDEX IF NOT EXISTS legacy_subscription_imports_email_idx
    ON legacy_subscription_imports(lower(email));

COMMENT ON TABLE legacy_subscription_imports IS
'Administrator-confirmed migration ledger for legacy paid subscription terms. It never represents a new provider charge and provider recurring IDs must be linked from verified live provider state separately.';
