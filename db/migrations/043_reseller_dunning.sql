BEGIN;

ALTER TABLE reseller_subscriptions
    ADD COLUMN IF NOT EXISTS manual_grace_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS manual_grace_reason TEXT,
    ADD COLUMN IF NOT EXISTS manual_grace_updated_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS manual_grace_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS reseller_subscriptions_manual_grace_idx
    ON reseller_subscriptions(manual_grace_until)
    WHERE manual_grace_until IS NOT NULL;

COMMIT;
