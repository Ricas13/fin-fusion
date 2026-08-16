BEGIN;

CREATE TABLE IF NOT EXISTS pending_registrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    referral_code TEXT,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS pending_registrations_email_open_idx
    ON pending_registrations((lower(email))) WHERE consumed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pending_registrations_username_open_idx
    ON pending_registrations((lower(username))) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS pending_registrations_expiry_idx
    ON pending_registrations(expires_at) WHERE consumed_at IS NULL;

ALTER TABLE referral_redemptions
    DROP CONSTRAINT IF EXISTS referral_redemptions_status_check;
ALTER TABLE referral_redemptions
    ADD CONSTRAINT referral_redemptions_status_check
    CHECK (status IN ('pending','rewarded','unfulfilled','reversed'));

CREATE TABLE IF NOT EXISTS referral_reward_reversals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    redemption_id UUID NOT NULL UNIQUE REFERENCES referral_redemptions(id) ON DELETE CASCADE,
    subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
    payment_incident_id UUID REFERENCES payment_incidents(id) ON DELETE SET NULL,
    days_reversed INTEGER NOT NULL DEFAULT 0 CHECK (days_reversed BETWEEN 0 AND 365),
    reason TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS referral_reward_reversals_incident_idx
    ON referral_reward_reversals(payment_incident_id);

COMMIT;
