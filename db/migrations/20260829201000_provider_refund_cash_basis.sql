BEGIN;

-- Refunds are cash-provider events. Affiliate/service credit is an internal
-- entitlement balance and must never increase the amount refundable as cash.
-- Historical/imported incidents without provider-paid evidence are left intact;
-- new/updated incidents that carry that evidence are enforced here.
CREATE OR REPLACE FUNCTION public.enforce_provider_refund_cash_basis()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    provider_paid_text text;
    provider_paid bigint;
BEGIN
    IF NEW.incident_type <> 'refund' OR NEW.amount_minor IS NULL THEN
        RETURN NEW;
    END IF;

    provider_paid_text := COALESCE(
        NEW.metadata->>'providerPaidMinor',
        NEW.metadata->>'originalAmountMinor'
    );

    IF provider_paid_text IS NULL THEN
        RETURN NEW;
    END IF;

    IF provider_paid_text !~ '^[0-9]+$' THEN
        RAISE EXCEPTION 'Refund provider-paid amount must be a non-negative integer';
    END IF;

    provider_paid := provider_paid_text::bigint;
    IF NEW.amount_minor < 0 THEN
        RAISE EXCEPTION 'Refund amount cannot be negative';
    END IF;
    IF NEW.amount_minor > provider_paid THEN
        RAISE EXCEPTION 'Cash refund (%) exceeds money paid through provider (%); affiliate/service credit is not cash-refundable', NEW.amount_minor, provider_paid;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_incidents_provider_refund_cash_basis ON payment_incidents;
CREATE TRIGGER payment_incidents_provider_refund_cash_basis
BEFORE INSERT OR UPDATE OF amount_minor, metadata, incident_type
ON payment_incidents
FOR EACH ROW
EXECUTE FUNCTION public.enforce_provider_refund_cash_basis();

COMMENT ON FUNCTION public.enforce_provider_refund_cash_basis() IS
    'Rejects refund incident amounts above evidenced provider cash paid. Affiliate/service-credit value must never become cash-refundable.';

COMMIT;
