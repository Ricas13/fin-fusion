BEGIN;

-- Legacy paid-user CSV migration restores an administrator-confirmed contract in
-- legacy_subscription_imports. That table is entitlement-authoritative for the
-- migrated term, while payment_history_transactions remains accounting-only.
--
-- The same original Stripe/PayPal transaction should nevertheless appear in
-- Payment History. Mirror only the accounting fact here; never create provider
-- import coverage, never invoke payment lifecycle handlers, and never let this
-- ledger row grant or prolong access.

-- Backfill legacy terms that were imported before this bridge existed. The CSV
-- export does not contain provider fee detail, so fee=0/net=gross means "fee
-- unknown in this legacy source", not an assertion that the provider charged no
-- fee. Metadata makes that limitation explicit.
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
)
SELECT
    lsi.provider,
    lsi.provider_transaction_id,
    CASE lsi.provider WHEN 'stripe' THEN 'charge' ELSE 'T0006' END,
    CASE lsi.provider WHEN 'stripe' THEN 'available' ELSE 'S' END,
    lsi.period_start,
    upper(lsi.currency),
    lsi.amount_minor,
    0,
    lsi.amount_minor,
    lsi.customer_id,
    jsonb_build_object(
        'legacyCsvSyntheticAccounting', TRUE,
        'legacyImportLinked', TRUE,
        'legacySubscriptionImportId', lsi.id,
        'legacyPaymentId', lsi.legacy_payment_id,
        'legacyPlanName', lsi.legacy_plan_name,
        'feeDataAvailable', FALSE
    )
FROM legacy_subscription_imports lsi
WHERE lsi.provider IN ('stripe','paypal')
ON CONFLICT(provider,provider_transaction_id) DO NOTHING;

-- If the authoritative provider-history importer already inserted this exact
-- provider transaction, preserve every provider-derived accounting field. Only
-- attach the customer/provenance link that the legacy migration can add safely.
UPDATE payment_history_transactions pht
SET customer_id=COALESCE(pht.customer_id,lsi.customer_id),
    metadata=pht.metadata || jsonb_build_object(
        'legacyImportLinked', TRUE,
        'legacySubscriptionImportId', lsi.id
    ),
    updated_at=NOW()
FROM legacy_subscription_imports lsi
WHERE lsi.provider IN ('stripe','paypal')
  AND pht.provider=lsi.provider
  AND pht.provider_transaction_id=lsi.provider_transaction_id;

CREATE OR REPLACE FUNCTION public.mirror_legacy_subscription_payment_to_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- Manual migration rows are local commercial records, not provider payment
    -- transactions, so they deliberately do not enter the provider ledger.
    IF NEW.provider NOT IN ('stripe','paypal') THEN
        RETURN NEW;
    END IF;

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
        CASE NEW.provider WHEN 'stripe' THEN 'charge' ELSE 'T0006' END,
        CASE NEW.provider WHEN 'stripe' THEN 'available' ELSE 'S' END,
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
END;
$$;

DROP TRIGGER IF EXISTS legacy_subscription_payment_history_bridge
    ON legacy_subscription_imports;
CREATE TRIGGER legacy_subscription_payment_history_bridge
AFTER INSERT ON legacy_subscription_imports
FOR EACH ROW
EXECUTE FUNCTION public.mirror_legacy_subscription_payment_to_history();

COMMENT ON FUNCTION public.mirror_legacy_subscription_payment_to_history() IS
'Mirrors administrator-confirmed legacy Stripe/PayPal payment facts into the accounting-only payment history ledger. It never creates provider import coverage and never changes subscription entitlement state.';

COMMIT;
