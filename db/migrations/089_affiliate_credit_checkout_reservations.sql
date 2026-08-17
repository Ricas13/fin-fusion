BEGIN;

CREATE TABLE IF NOT EXISTS affiliate_credit_checkout_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    checkout_intent_id UUID NOT NULL UNIQUE REFERENCES billing_checkout_intents(id) ON DELETE CASCADE,
    currency CHAR(3) NOT NULL CHECK (currency IN ('GBP','USD','EUR')),
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','applied','released')),
    expires_at TIMESTAMPTZ NOT NULL,
    applied_at TIMESTAMPTZ,
    released_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS affiliate_credit_checkout_reservations_balance_idx
    ON affiliate_credit_checkout_reservations(customer_id,currency,state,expires_at);

COMMIT;
