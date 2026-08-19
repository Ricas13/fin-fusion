ALTER TABLE customer_entitlement_overrides
    DROP CONSTRAINT IF EXISTS customer_entitlement_overrides_subscription_id_fkey;

ALTER TABLE customer_entitlement_overrides
    ADD CONSTRAINT customer_entitlement_overrides_subscription_id_fkey
    FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE;
