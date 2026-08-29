BEGIN;

-- Service credit reserved for a specific provider renewal invoice. The reservation
-- keeps the same credit from being spent by checkout/full-redemption while the
-- provider invoice is still open. Economic consumption is recorded in the
-- affiliate ledger only after the invoice is actually paid.
CREATE TABLE affiliate_credit_renewal_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    provider VARCHAR(20) NOT NULL CHECK (provider IN ('stripe')),
    provider_invoice_id VARCHAR(255) NOT NULL,
    provider_adjustment_id VARCHAR(255),
    currency CHAR(3) NOT NULL CHECK (currency IN ('GBP','USD','EUR')),
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    state VARCHAR(32) NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','provider_applied','consumed','released')),
    applied_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ,
    released_at TIMESTAMPTZ,
    release_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(provider, provider_invoice_id)
);

CREATE INDEX affiliate_credit_renewal_reservations_customer_currency_idx
    ON affiliate_credit_renewal_reservations(customer_id,currency,state);
CREATE INDEX affiliate_credit_renewal_reservations_subscription_idx
    ON affiliate_credit_renewal_reservations(subscription_id,created_at DESC);

COMMENT ON TABLE affiliate_credit_renewal_reservations IS
    'Durable reservation of service credit against one provider renewal invoice. Reserved/provider_applied amounts are unavailable elsewhere; consumed rows have a matching redeemed affiliate ledger debit.';

COMMIT;
