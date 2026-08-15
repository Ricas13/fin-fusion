BEGIN;

-- Keep the exact Stripe price committed to a reseller downgrade beside the
-- pending tier. Later catalogue/provider-mapping retirement must not make the
-- renewal worker forget the provider contract that was already scheduled.
ALTER TABLE reseller_subscriptions
    ADD COLUMN IF NOT EXISTS pending_tier_source_price_id TEXT,
    ADD COLUMN IF NOT EXISTS pending_tier_target_price_id TEXT;

CREATE INDEX IF NOT EXISTS reseller_subscriptions_pending_schedule_idx
    ON reseller_subscriptions(pending_tier_provider_schedule_id)
    WHERE pending_tier_provider_schedule_id IS NOT NULL;

COMMIT;
