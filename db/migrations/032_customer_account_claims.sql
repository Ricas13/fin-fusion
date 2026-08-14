BEGIN;

CREATE TABLE IF NOT EXISTS customer_account_claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    token_encrypted TEXT NOT NULL,
    email_lock TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    claimed_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS customer_account_claims_customer_idx
    ON customer_account_claims(customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS customer_account_claims_active_idx
    ON customer_account_claims(expires_at)
    WHERE consumed_at IS NULL AND revoked_at IS NULL;

COMMIT;
