BEGIN;

-- A given subscription can only ever record one discount redemption. This backs
-- redeemForSubscriptionTx()'s ON CONFLICT DO NOTHING, making activation-time
-- redemption idempotent against webhook/event retries for the same subscription.
CREATE UNIQUE INDEX IF NOT EXISTS discount_redemptions_subscription_unique
    ON discount_redemptions(subscription_id)
    WHERE subscription_id IS NOT NULL;

COMMIT;
