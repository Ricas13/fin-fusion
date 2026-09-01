BEGIN;

ALTER TABLE media_account_device_policy
    ADD COLUMN IF NOT EXISTS subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL;

ALTER TABLE media_account_devices
    ADD COLUMN IF NOT EXISTS subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL;

-- Pre-entitlement-scope registrations cannot be trusted as belonging to the
-- customer's current contract. Keep them as history, but never let them consume
-- slots on a new entitlement.
UPDATE media_account_devices
SET revoked_at=COALESCE(revoked_at,NOW()),updated_at=NOW()
WHERE subscription_id IS NULL AND revoked_at IS NULL;

ALTER TABLE media_account_devices
    DROP CONSTRAINT IF EXISTS media_account_devices_account_device_unique;

DROP INDEX IF EXISTS media_account_devices_active_idx;
DROP INDEX IF EXISTS media_account_devices_entitlement_device_unique;

-- Device authorisation belongs to the entitlement, not to one server/account
-- mapping. If that customer is moved to another Jellyfin/Emby server while the
-- same subscription remains active, the same registered DeviceIds must still
-- consume the same slots instead of silently starting a fresh allowance.
CREATE UNIQUE INDEX IF NOT EXISTS media_account_devices_entitlement_device_unique
    ON media_account_devices(subscription_id,device_id)
    WHERE subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS media_account_devices_active_idx
    ON media_account_devices(subscription_id,registered_at,device_id)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS media_account_device_policy_subscription_idx
    ON media_account_device_policy(subscription_id)
    WHERE subscription_id IS NOT NULL;

COMMENT ON COLUMN media_account_device_policy.subscription_id IS
    'Current entitlement whose persistent registered-device slots CAPTAiNFiN is enforcing for this media account.';
COMMENT ON COLUMN media_account_devices.subscription_id IS
    'Entitlement that owns this registered-device slot across media-server/account moves. A later subscription starts with a fresh slot set.';

COMMIT;
