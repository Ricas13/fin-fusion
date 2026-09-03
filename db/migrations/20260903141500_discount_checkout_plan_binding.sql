BEGIN;

CREATE OR REPLACE FUNCTION public.enforce_discount_checkout_plan_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    allowed_codes TEXT[];
    checkout_plan_code TEXT;
BEGIN
    SELECT d.plan_codes, p.code
    INTO allowed_codes, checkout_plan_code
    FROM public.discount_codes d
    JOIN public.billing_checkout_intents i ON i.id = NEW.checkout_intent_id
    LEFT JOIN public.plans p ON p.id = i.plan_id
    WHERE d.id = NEW.discount_code_id;

    IF COALESCE(array_length(allowed_codes, 1), 0) > 0
       AND (checkout_plan_code IS NULL OR NOT checkout_plan_code = ANY(allowed_codes)) THEN
        RAISE EXCEPTION 'Discount reservation plan does not match checkout intent'
            USING ERRCODE = '23514',
                  CONSTRAINT = 'discount_checkout_reservation_plan_binding';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS discount_checkout_reservation_plan_binding
ON public.discount_checkout_reservations;

CREATE TRIGGER discount_checkout_reservation_plan_binding
BEFORE INSERT OR UPDATE OF discount_code_id, checkout_intent_id
ON public.discount_checkout_reservations
FOR EACH ROW
EXECUTE FUNCTION public.enforce_discount_checkout_plan_binding();

COMMIT;
