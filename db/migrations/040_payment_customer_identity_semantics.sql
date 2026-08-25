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

-- Keep the durable provider-customer mirror in the same database transaction as
-- subscription activation/linking. This closes the old window where the
-- subscription could commit and a later application-level mapping write could
-- fail. It also protects future/import linking paths that update subscriptions
-- directly rather than going through one particular application helper.
CREATE OR REPLACE FUNCTION sync_subscription_payment_customer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.source IN ('stripe', 'paypal', 'plisio')
       AND NULLIF(BTRIM(COALESCE(NEW.provider_customer_id, '')), '') IS NOT NULL THEN
        INSERT INTO payment_customers(customer_id, provider, provider_customer_id)
        VALUES(NEW.customer_id, NEW.source, NEW.provider_customer_id)
        ON CONFLICT(customer_id, provider)
        DO UPDATE SET
            provider_customer_id = EXCLUDED.provider_customer_id,
            updated_at = NOW();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subscriptions_sync_payment_customer ON subscriptions;
CREATE TRIGGER subscriptions_sync_payment_customer
AFTER INSERT OR UPDATE OF customer_id, source, provider_customer_id
ON subscriptions
FOR EACH ROW
EXECUTE FUNCTION sync_subscription_payment_customer();

-- Backfill any provider identities already present on subscriptions before this
-- trigger existed. PayPal fan-in is intentionally allowed; Stripe collisions
-- still fail against the partial unique index and therefore cannot be hidden.
INSERT INTO payment_customers(customer_id, provider, provider_customer_id)
SELECT DISTINCT ON (s.customer_id, s.source)
       s.customer_id,
       s.source,
       s.provider_customer_id
FROM subscriptions s
WHERE s.source IN ('stripe', 'paypal', 'plisio')
  AND NULLIF(BTRIM(COALESCE(s.provider_customer_id, '')), '') IS NOT NULL
ORDER BY s.customer_id, s.source, s.updated_at DESC, s.created_at DESC
ON CONFLICT(customer_id, provider)
DO UPDATE SET
    provider_customer_id = EXCLUDED.provider_customer_id,
    updated_at = NOW();
