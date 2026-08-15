BEGIN;

ALTER TABLE reseller_subscriptions
    ADD COLUMN IF NOT EXISTS manual_grace_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS manual_grace_reason TEXT,
    ADD COLUMN IF NOT EXISTS manual_grace_updated_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS manual_grace_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS reseller_subscriptions_manual_grace_idx
    ON reseller_subscriptions(manual_grace_until)
    WHERE manual_grace_until IS NOT NULL;

CREATE OR REPLACE FUNCTION clear_reseller_manual_grace_on_recovery()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status='active' AND OLD.status IS DISTINCT FROM 'active' THEN
        NEW.manual_grace_until := NULL;
        NEW.manual_grace_reason := NULL;
        NEW.manual_grace_updated_by := NULL;
        NEW.manual_grace_updated_at := NULL;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS reseller_manual_grace_recovery_trigger ON reseller_subscriptions;
CREATE TRIGGER reseller_manual_grace_recovery_trigger
BEFORE UPDATE OF status ON reseller_subscriptions
FOR EACH ROW EXECUTE FUNCTION clear_reseller_manual_grace_on_recovery();

COMMIT;
