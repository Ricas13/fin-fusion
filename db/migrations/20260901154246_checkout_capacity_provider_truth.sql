BEGIN;

ALTER TABLE billing_checkout_intents
    ADD COLUMN IF NOT EXISTS capacity_hold_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS provider_terminal_at TIMESTAMPTZ;

-- Local checkout expiry/cancellation is not proof that an already-created
-- provider checkout can no longer take money. Backfill a conservative provider
-- settlement window for attached historical intents while keeping unattached
-- intents on their existing local expiry.
UPDATE billing_checkout_intents
SET capacity_hold_until = CASE
    WHEN provider_checkout_id IS NULL OR btrim(provider_checkout_id) = '' THEN expires_at
    WHEN provider = 'paypal' THEN GREATEST(expires_at, created_at + INTERVAL '7 hours')
    WHEN provider = 'plisio' THEN GREATEST(expires_at, created_at + INTERVAL '190 minutes')
    WHEN provider = 'stripe' THEN GREATEST(expires_at, created_at + INTERVAL '70 minutes')
    ELSE expires_at
END
WHERE capacity_hold_until IS NULL;

-- Completed rows and terminal local rows that never reached a provider are
-- already conclusive. Attached cancelled/failed/expired rows deliberately stay
-- unresolved so their capacity remains protected until provider truth or the
-- safety backstop above.
UPDATE billing_checkout_intents
SET provider_terminal_at = COALESCE(completed_at, updated_at, NOW())
WHERE provider_terminal_at IS NULL
  AND (
      state = 'completed'
      OR (
          (provider_checkout_id IS NULL OR btrim(provider_checkout_id) = '')
          AND state IN ('cancelled', 'failed', 'expired')
      )
  );

CREATE INDEX IF NOT EXISTS billing_checkout_intents_capacity_hold_idx
    ON billing_checkout_intents(plan_id, capacity_hold_until)
    WHERE provider_checkout_id IS NOT NULL
      AND provider_terminal_at IS NULL
      AND state <> 'completed';

COMMENT ON COLUMN billing_checkout_intents.capacity_hold_until IS
    'Capacity safety backstop. Attached provider checkouts keep inventory reserved until provider-terminal truth or this time, even after local cancel/expiry.';

COMMENT ON COLUMN billing_checkout_intents.provider_terminal_at IS
    'Timestamp when provider truth proved the checkout terminal (completed/cancelled/failed), allowing retained capacity to be released immediately.';

COMMIT;
