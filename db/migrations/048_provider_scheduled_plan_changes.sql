BEGIN;

ALTER TABLE customer_plan_changes
    ADD COLUMN IF NOT EXISTS provider_schedule_id TEXT,
    ADD COLUMN IF NOT EXISTS provider_schedule_state TEXT,
    ADD COLUMN IF NOT EXISTS provider_action_required BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS source_price_id TEXT,
    ADD COLUMN IF NOT EXISTS target_price_id TEXT;

CREATE INDEX IF NOT EXISTS customer_plan_changes_provider_schedule_idx
    ON customer_plan_changes(provider,provider_schedule_id)
    WHERE provider_schedule_id IS NOT NULL;

-- Reseller tier changes are stored on the reseller subscription itself. Keep
-- the provider schedule reference alongside the pending tier so reconciliation
-- can prove Stripe owns the future billing transition.
ALTER TABLE reseller_subscriptions
    ADD COLUMN IF NOT EXISTS pending_tier_provider_schedule_id TEXT,
    ADD COLUMN IF NOT EXISTS pending_tier_provider_schedule_state TEXT;

COMMIT;
