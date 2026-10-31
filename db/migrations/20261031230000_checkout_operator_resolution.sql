-- An operator can close a crypto checkout that automation could not settle (dismiss it as
-- abandoned, or record that it was paid). The columns record who decided, when and why, so the
-- exception queue can hide it and the recovery worker leaves it alone.
ALTER TABLE public.billing_checkout_intents
    ADD COLUMN IF NOT EXISTS operator_resolved_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS operator_resolved_by uuid,
    ADD COLUMN IF NOT EXISTS operator_resolution text,
    ADD COLUMN IF NOT EXISTS operator_resolution_note text;

ALTER TABLE public.billing_checkout_intents
    DROP CONSTRAINT IF EXISTS billing_checkout_intents_operator_resolution_check;
ALTER TABLE public.billing_checkout_intents
    ADD CONSTRAINT billing_checkout_intents_operator_resolution_check
    CHECK (operator_resolution IS NULL OR operator_resolution IN ('dismissed','marked_paid'));
