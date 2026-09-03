BEGIN;

CREATE TABLE IF NOT EXISTS public.automatic_free_downgrade_retries (
    customer_id uuid PRIMARY KEY REFERENCES public.customers(id) ON DELETE CASCADE,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
    last_attempt_at timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS automatic_free_downgrade_retries_due_idx
    ON public.automatic_free_downgrade_retries(next_attempt_at,customer_id);

COMMENT ON TABLE public.automatic_free_downgrade_retries IS
    'Durable retry markers created only when a configured automatic paid-to-Free downgrade throws after paid expiry. Generic no-entitlement customers are never inferred into this queue.';

COMMIT;
