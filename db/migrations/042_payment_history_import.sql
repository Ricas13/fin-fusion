-- Historical Stripe/PayPal accounting is intentionally isolated from live
-- subscription and entitlement state. Importing old provider transactions must
-- never reactivate access or feed lifecycle webhook handlers.

CREATE TABLE IF NOT EXISTS payment_history_import_runs (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    provider_scope text NOT NULL CHECK (provider_scope IN ('stripe', 'paypal', 'both')),
    range_start date NOT NULL,
    range_end date NOT NULL,
    status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed')),
    total_seen integer NOT NULL DEFAULT 0 CHECK (total_seen >= 0),
    imported_count integer NOT NULL DEFAULT 0 CHECK (imported_count >= 0),
    existing_count integer NOT NULL DEFAULT 0 CHECK (existing_count >= 0),
    matched_count integer NOT NULL DEFAULT 0 CHECK (matched_count >= 0),
    unmatched_count integer NOT NULL DEFAULT 0 CHECK (unmatched_count >= 0),
    requested_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
    error_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz NOT NULL DEFAULT now(),
    CHECK (range_end >= range_start)
);

CREATE TABLE IF NOT EXISTS payment_history_transactions (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    provider text NOT NULL CHECK (provider IN ('stripe', 'paypal')),
    provider_transaction_id text NOT NULL,
    transaction_type text NOT NULL,
    transaction_status text,
    occurred_at timestamptz NOT NULL,
    currency text NOT NULL,
    gross_amount_minor bigint NOT NULL DEFAULT 0,
    fee_amount_minor bigint NOT NULL DEFAULT 0,
    net_amount_minor bigint NOT NULL DEFAULT 0,
    provider_customer_id text,
    provider_reference_id text,
    provider_source_id text,
    customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
    first_import_run_id uuid REFERENCES payment_history_import_runs(id) ON DELETE SET NULL,
    last_import_run_id uuid REFERENCES payment_history_import_runs(id) ON DELETE SET NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(provider, provider_transaction_id)
);

CREATE INDEX IF NOT EXISTS payment_history_transactions_occurred_idx
    ON payment_history_transactions(occurred_at DESC);
CREATE INDEX IF NOT EXISTS payment_history_transactions_provider_occurred_idx
    ON payment_history_transactions(provider, occurred_at DESC);
CREATE INDEX IF NOT EXISTS payment_history_transactions_customer_idx
    ON payment_history_transactions(customer_id, occurred_at DESC)
    WHERE customer_id IS NOT NULL;

COMMENT ON TABLE payment_history_transactions IS
'Historical provider accounting ledger only. Rows here are never entitlement-authoritative.';
