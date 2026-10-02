BEGIN;

-- One canonical provider-identity graph connects provider resources back to the
-- CAPTAiNFiN customer that owns them. This deliberately allows a customer to
-- retain historical provider identities (for example an older Stripe cus_ ID)
-- instead of payment_customers' one-current-ID-per-provider shape losing that
-- history.
CREATE TABLE IF NOT EXISTS payment_provider_identities (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider IN ('stripe','paypal','plisio')),
    resource_type text NOT NULL CHECK (resource_type IN (
        'customer','billing_reference','checkout','transaction','reference','source'
    )),
    provider_identity text NOT NULL,
    source text NOT NULL DEFAULT 'runtime',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at timestamptz NOT NULL DEFAULT NOW(),
    last_seen_at timestamptz NOT NULL DEFAULT NOW(),
    UNIQUE(provider,resource_type,provider_identity)
);

CREATE INDEX IF NOT EXISTS payment_provider_identities_customer_idx
    ON payment_provider_identities(customer_id,provider,last_seen_at DESC);
CREATE INDEX IF NOT EXISTS payment_provider_identities_lookup_idx
    ON payment_provider_identities(provider,provider_identity);

-- Plisio is a first-class payment provider everywhere else already. Include it
-- in the canonical customer/ledger schema too so customer history and accounting
-- do not silently omit successful crypto payments.
ALTER TABLE payment_history_transactions
    DROP CONSTRAINT IF EXISTS payment_history_transactions_provider_check;
ALTER TABLE payment_history_transactions
    ADD CONSTRAINT payment_history_transactions_provider_check
    CHECK (provider IN ('stripe','paypal','plisio'));

ALTER TABLE payment_customers
    DROP CONSTRAINT IF EXISTS payment_customers_provider_check;
ALTER TABLE payment_customers
    ADD CONSTRAINT payment_customers_provider_check
    CHECK (provider IN ('stripe','paypal','plisio'));

-- Seed only identities whose existing local evidence has exactly one owner.
-- Conflicting legacy evidence remains untouched for operator review rather than
-- selecting an arbitrary customer.
WITH evidence AS (
    SELECT customer_id,provider,'customer'::text resource_type,provider_customer_id provider_identity,created_at seen_at
      FROM payment_customers
     WHERE provider IN ('stripe','paypal','plisio')
    UNION ALL
    SELECT customer_id,source,'customer',provider_customer_id,created_at
      FROM subscriptions
     WHERE source IN ('stripe','paypal','plisio') AND provider_customer_id IS NOT NULL
    UNION ALL
    SELECT customer_id,source,'billing_reference',provider_subscription_id,created_at
      FROM subscriptions
     WHERE source IN ('stripe','paypal','plisio') AND provider_subscription_id IS NOT NULL
    UNION ALL
    SELECT customer_id,provider,'checkout',provider_checkout_id,created_at
      FROM billing_checkout_intents
     WHERE provider IN ('stripe','paypal','plisio') AND customer_id IS NOT NULL AND provider_checkout_id IS NOT NULL
    UNION ALL
    SELECT customer_id,provider,'transaction',provider_transaction_id,created_at
      FROM payment_history_transactions
     WHERE provider IN ('stripe','paypal','plisio') AND customer_id IS NOT NULL
    UNION ALL
    SELECT customer_id,provider,'customer',provider_customer_id,created_at
      FROM payment_history_transactions
     WHERE provider IN ('stripe','paypal','plisio') AND customer_id IS NOT NULL AND provider_customer_id IS NOT NULL
    UNION ALL
    SELECT customer_id,provider,'reference',provider_reference_id,created_at
      FROM payment_history_transactions
     WHERE provider IN ('stripe','paypal','plisio') AND customer_id IS NOT NULL AND provider_reference_id IS NOT NULL
    UNION ALL
    SELECT customer_id,provider,'source',provider_source_id,created_at
      FROM payment_history_transactions
     WHERE provider IN ('stripe','paypal','plisio') AND customer_id IS NOT NULL AND provider_source_id IS NOT NULL
),
safe AS (
    SELECT provider,resource_type,provider_identity,
           (ARRAY_AGG(DISTINCT customer_id))[1] customer_id,
           MIN(seen_at) first_seen_at,MAX(seen_at) last_seen_at
      FROM evidence
     WHERE provider_identity IS NOT NULL AND BTRIM(provider_identity)<>''
     GROUP BY provider,resource_type,provider_identity
    HAVING COUNT(DISTINCT customer_id)=1
)
INSERT INTO payment_provider_identities(
    customer_id,provider,resource_type,provider_identity,source,first_seen_at,last_seen_at
)
SELECT customer_id,provider,resource_type,provider_identity,'migration_backfill',first_seen_at,last_seen_at
  FROM safe
ON CONFLICT(provider,resource_type,provider_identity) DO NOTHING;

-- Reconnect historical ledger rows that already carry an identity known
-- elsewhere. A row is linked only when every piece of matching evidence agrees
-- on exactly one customer.
WITH candidates AS (
    SELECT t.id,i.customer_id
      FROM payment_history_transactions t
      JOIN payment_provider_identities i
        ON i.provider=t.provider
       AND i.provider_identity = ANY(ARRAY_REMOVE(ARRAY[
            t.provider_customer_id,t.provider_transaction_id,t.provider_reference_id,t.provider_source_id
       ],NULL))
     WHERE t.customer_id IS NULL
    UNION ALL
    SELECT t.id,b.customer_id
      FROM payment_history_transactions t
      JOIN billing_checkout_intents b
        ON b.provider=t.provider
       AND b.customer_id IS NOT NULL
       AND (
            b.provider_checkout_id = ANY(ARRAY_REMOVE(ARRAY[
                t.provider_transaction_id,t.provider_reference_id,t.provider_source_id
            ],NULL))
            OR b.id::text=COALESCE(t.metadata->>'checkoutIntentId',t.metadata->>'internal_checkout_intent_id')
       )
     WHERE t.customer_id IS NULL
),
resolved AS (
    SELECT id,(ARRAY_AGG(DISTINCT customer_id))[1] customer_id
      FROM candidates
     GROUP BY id
    HAVING COUNT(DISTINCT customer_id)=1
)
UPDATE payment_history_transactions t
   SET customer_id=r.customer_id,
       metadata=t.metadata || jsonb_build_object('ownershipReconciled',TRUE,'ownershipReconciledBy','20261002_provider_identity_graph'),
       updated_at=NOW()
  FROM resolved r
 WHERE t.id=r.id
   AND t.customer_id IS NULL;

-- Newly repaired ledger ownership becomes evidence for future reconciliation.
WITH evidence AS (
    SELECT customer_id,provider,'transaction'::text resource_type,provider_transaction_id provider_identity,created_at seen_at
      FROM payment_history_transactions
     WHERE customer_id IS NOT NULL
    UNION ALL
    SELECT customer_id,provider,'customer',provider_customer_id,created_at
      FROM payment_history_transactions
     WHERE customer_id IS NOT NULL AND provider_customer_id IS NOT NULL
    UNION ALL
    SELECT customer_id,provider,'reference',provider_reference_id,created_at
      FROM payment_history_transactions
     WHERE customer_id IS NOT NULL AND provider_reference_id IS NOT NULL
    UNION ALL
    SELECT customer_id,provider,'source',provider_source_id,created_at
      FROM payment_history_transactions
     WHERE customer_id IS NOT NULL AND provider_source_id IS NOT NULL
),
safe AS (
    SELECT provider,resource_type,provider_identity,
           (ARRAY_AGG(DISTINCT customer_id))[1] customer_id,
           MIN(seen_at) first_seen_at,MAX(seen_at) last_seen_at
      FROM evidence
     WHERE provider IN ('stripe','paypal','plisio')
       AND provider_identity IS NOT NULL AND BTRIM(provider_identity)<>''
     GROUP BY provider,resource_type,provider_identity
    HAVING COUNT(DISTINCT customer_id)=1
)
INSERT INTO payment_provider_identities(
    customer_id,provider,resource_type,provider_identity,source,first_seen_at,last_seen_at
)
SELECT customer_id,provider,resource_type,provider_identity,'ledger_repair',first_seen_at,last_seen_at
  FROM safe
ON CONFLICT(provider,resource_type,provider_identity) DO NOTHING;

-- Replace the provider-specific scheduled job with one provider-wide financial
-- reconciliation job while preserving operator scheduling/history when present.
INSERT INTO automation_job_state(
    job_key,enabled,interval_seconds,last_started_at,last_success_at,last_error,
    last_duration_ms,last_processed_count,consecutive_failures,next_run_at,updated_at,force_run_requested
)
SELECT
    'provider_financial_reconciliation',enabled,interval_seconds,last_started_at,last_success_at,last_error,
    last_duration_ms,last_processed_count,consecutive_failures,next_run_at,updated_at,force_run_requested
FROM automation_job_state
WHERE job_key='paypal_history_reconciliation'
ON CONFLICT(job_key) DO NOTHING;

DELETE FROM automation_job_state
WHERE job_key='paypal_history_reconciliation';

COMMIT;
