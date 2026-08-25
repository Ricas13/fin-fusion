-- Payment-provider customer references do not all have the same cardinality.
--
-- Stripe customer objects are created by CAPTAiNFiN per local customer, so a
-- Stripe cus_ identifier must never belong to two CAPTAiNFiN customers.
--
-- PayPal payer IDs identify the funding PayPal account, not the CAPTAiNFiN
-- customer. The same PayPal account can legitimately fund more than one local
-- account, while actual subscription ownership remains bound by the unique
-- PayPal I- agreement/subscription ID and the server-authored checkout intent.
--
-- Plisio has no durable provider-customer identity today, but it is a supported
-- payment provider and the table-level provider allowlist should not be stale.

ALTER TABLE payment_customers
    DROP CONSTRAINT IF EXISTS payment_customers_provider_check;

ALTER TABLE payment_customers
    ADD CONSTRAINT payment_customers_provider_check
    CHECK (provider IN ('stripe', 'paypal', 'plisio'));

-- The former global uniqueness rule incorrectly treated a PayPal payer ID like
-- a Stripe customer object and caused a second legitimate CAPTAiNFiN account
-- funded by the same PayPal payer to fail after subscription activation.
ALTER TABLE payment_customers
    DROP CONSTRAINT IF EXISTS payment_customers_provider_provider_customer_id_key;

-- Preserve the strict one-to-one invariant where it is actually valid.
CREATE UNIQUE INDEX IF NOT EXISTS payment_customers_stripe_customer_identity_key
    ON payment_customers(provider, provider_customer_id)
    WHERE provider = 'stripe';
