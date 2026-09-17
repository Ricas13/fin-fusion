BEGIN;

-- Legacy Stripe CSV rows stored a PaymentIntent (pi_...) while the real
-- accounting ledger uses Stripe balance transactions (txn_...) and keeps the
-- PaymentIntent in provider_reference_id.
--
-- The old bridge also used subscription period_start as occurred_at, which can
-- create apparent successful payments in the future. Repair those duplicates
-- without modifying subscriptions or entitlement/access state.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM payment_history_transactions s
        JOIN payment_history_transactions r
          ON r.provider='stripe'
         AND r.provider_reference_id=s.provider_transaction_id
        WHERE s.provider='stripe'
          AND COALESCE(s.metadata->>'legacyCsvSyntheticAccounting','false')='true'
          AND COALESCE(r.metadata->>'legacyCsvSyntheticAccounting','false')<>'true'
          AND s.customer_id IS NOT NULL
          AND r.customer_id IS NOT NULL
          AND r.customer_id IS DISTINCT FROM s.customer_id
    ) THEN
        RAISE EXCEPTION 'Legacy Stripe repair found conflicting customer ownership';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM (
            SELECT s.id
            FROM payment_history_transactions s
            JOIN payment_history_transactions r
              ON r.provider='stripe'
             AND r.provider_reference_id=s.provider_transaction_id
            WHERE s.provider='stripe'
              AND COALESCE(s.metadata->>'legacyCsvSyntheticAccounting','false')='true'
              AND COALESCE(r.metadata->>'legacyCsvSyntheticAccounting','false')<>'true'
            GROUP BY s.id
            HAVING COUNT(*) > 1
        ) ambiguous
    ) THEN
        RAISE EXCEPTION 'Legacy Stripe repair found an ambiguous PaymentIntent mapping';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM (
            SELECT r.id
            FROM payment_history_transactions s
            JOIN payment_history_transactions r
              ON r.provider='stripe'
             AND r.provider_reference_id=s.provider_transaction_id
            WHERE s.provider='stripe'
              AND COALESCE(s.metadata->>'legacyCsvSyntheticAccounting','false')='true'
              AND COALESCE(r.metadata->>'legacyCsvSyntheticAccounting','false')<>'true'
            GROUP BY r.id
            HAVING COUNT(DISTINCT s.customer_id) > 1
        ) conflicting
    ) THEN
        RAISE EXCEPTION 'Legacy Stripe repair found one real payment mapped to multiple customers';
    END IF;
END
$$;

WITH matches AS (
    SELECT
        s.id AS synthetic_id,
        s.customer_id,
        s.metadata AS synthetic_metadata,
        r.id AS real_id
    FROM payment_history_transactions s
    JOIN payment_history_transactions r
      ON r.provider='stripe'
     AND r.provider_reference_id=s.provider_transaction_id
    WHERE s.provider='stripe'
      AND COALESCE(s.metadata->>'legacyCsvSyntheticAccounting','false')='true'
      AND COALESCE(r.metadata->>'legacyCsvSyntheticAccounting','false')<>'true'
)
UPDATE payment_history_transactions r
SET
    customer_id=COALESCE(r.customer_id,m.customer_id),
    metadata=r.metadata || jsonb_strip_nulls(jsonb_build_object(
        'legacyImportLinked', TRUE,
        'legacySubscriptionImportId', m.synthetic_metadata->>'legacySubscriptionImportId',
        'legacyPaymentId', m.synthetic_metadata->>'legacyPaymentId',
        'legacyPlanName', m.synthetic_metadata->>'legacyPlanName',
        'legacySyntheticRowRetired', TRUE
    )),
    updated_at=NOW()
FROM matches m
WHERE r.id=m.real_id
  AND (r.customer_id IS NULL OR r.customer_id=m.customer_id);

DELETE FROM payment_history_transactions s
USING payment_history_transactions r
WHERE s.provider='stripe'
  AND COALESCE(s.metadata->>'legacyCsvSyntheticAccounting','false')='true'
  AND r.provider='stripe'
  AND r.provider_reference_id=s.provider_transaction_id
  AND COALESCE(r.metadata->>'legacyCsvSyntheticAccounting','false')<>'true';

-- Future Stripe legacy imports may attach ownership/provenance to an existing
-- authoritative row, but must never manufacture a payment using period_start.
-- Keep the existing PayPal legacy behaviour unchanged in this repair.
CREATE OR REPLACE FUNCTION public.mirror_legacy_subscription_payment_to_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.provider='stripe' THEN
        UPDATE payment_history_transactions
        SET
            customer_id=COALESCE(customer_id,NEW.customer_id),
            metadata=metadata || jsonb_strip_nulls(jsonb_build_object(
                'legacyImportLinked', TRUE,
                'legacySubscriptionImportId', NEW.id,
                'legacyPaymentId', NEW.legacy_payment_id,
                'legacyPlanName', NEW.legacy_plan_name
            )),
            updated_at=NOW()
        WHERE provider='stripe'
          AND provider_reference_id=NEW.provider_transaction_id
          AND COALESCE(metadata->>'legacyCsvSyntheticAccounting','false')<>'true'
          AND (customer_id IS NULL OR customer_id=NEW.customer_id);

        RETURN NEW;
    END IF;

    IF NEW.provider='paypal' THEN
        INSERT INTO payment_history_transactions(
            provider,
            provider_transaction_id,
            transaction_type,
            transaction_status,
            occurred_at,
            currency,
            gross_amount_minor,
            fee_amount_minor,
            net_amount_minor,
            customer_id,
            metadata
        ) VALUES (
            NEW.provider,
            NEW.provider_transaction_id,
            'T0006',
            'S',
            NEW.period_start,
            upper(NEW.currency),
            NEW.amount_minor,
            0,
            NEW.amount_minor,
            NEW.customer_id,
            jsonb_build_object(
                'legacyCsvSyntheticAccounting', TRUE,
                'legacyImportLinked', TRUE,
                'legacySubscriptionImportId', NEW.id,
                'legacyPaymentId', NEW.legacy_payment_id,
                'legacyPlanName', NEW.legacy_plan_name,
                'feeDataAvailable', FALSE
            )
        )
        ON CONFLICT(provider,provider_transaction_id) DO UPDATE SET
            customer_id=COALESCE(payment_history_transactions.customer_id,NEW.customer_id),
            metadata=payment_history_transactions.metadata || jsonb_build_object(
                'legacyImportLinked', TRUE,
                'legacySubscriptionImportId', NEW.id
            ),
            updated_at=NOW();

        RETURN NEW;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS legacy_subscription_payment_history_bridge
ON legacy_subscription_imports;

CREATE TRIGGER legacy_subscription_payment_history_bridge
AFTER INSERT ON legacy_subscription_imports
FOR EACH ROW
EXECUTE FUNCTION public.mirror_legacy_subscription_payment_to_history();

COMMENT ON FUNCTION public.mirror_legacy_subscription_payment_to_history() IS
'Links legacy Stripe ownership onto authoritative provider accounting rather than manufacturing Stripe payments from subscription-period dates. Existing PayPal legacy behaviour is preserved.';

COMMIT;
