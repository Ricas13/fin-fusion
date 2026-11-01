-- An operator can close a crypto checkout that automation could not settle (dismiss it as
-- abandoned, or record that it was paid). The columns record who decided, when and why, so the
-- exception queue can hide it and the recovery worker leaves it alone. 'marked_paid_review' is a
-- payment that was only partly recorded and still needs a person to verify it.
ALTER TABLE public.billing_checkout_intents
    ADD COLUMN IF NOT EXISTS operator_resolved_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS operator_resolved_by uuid,
    ADD COLUMN IF NOT EXISTS operator_resolution text,
    ADD COLUMN IF NOT EXISTS operator_resolution_note text;

-- Add the constraint only when it is absent, so re-running the migration takes no table lock.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='billing_checkout_intents_operator_resolution_v2_check'
                   AND conrelid='public.billing_checkout_intents'::regclass) THEN
        ALTER TABLE public.billing_checkout_intents DROP CONSTRAINT IF EXISTS billing_checkout_intents_operator_resolution_check;
        ALTER TABLE public.billing_checkout_intents
            ADD CONSTRAINT billing_checkout_intents_operator_resolution_v2_check
            CHECK (operator_resolution IS NULL OR operator_resolution IN ('dismissed','marked_paid','marked_paid_review'));
    END IF;
END $$;
