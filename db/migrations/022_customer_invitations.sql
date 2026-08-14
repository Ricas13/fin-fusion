BEGIN;

ALTER TABLE subscriptions
    DROP CONSTRAINT IF EXISTS subscriptions_source_check;

ALTER TABLE subscriptions
    ADD CONSTRAINT subscriptions_source_check
        CHECK (source IN ('manual','reseller_credit','stripe','paypal','migration','invitation'));

CREATE TABLE IF NOT EXISTS customer_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
    token_hash TEXT NOT NULL UNIQUE,
    invited_email TEXT,
    single_use BOOLEAN NOT NULL DEFAULT TRUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (invited_email IS NULL OR length(invited_email) <= 254),
    CHECK (expires_at > created_at)
);

CREATE TABLE IF NOT EXISTS invitation_redemptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invitation_id UUID NOT NULL REFERENCES customer_invitations(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    redeemed_email TEXT NOT NULL,
    redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(invitation_id, customer_id)
);

CREATE INDEX IF NOT EXISTS customer_invitations_plan_idx
    ON customer_invitations(plan_id, created_at DESC);
CREATE INDEX IF NOT EXISTS customer_invitations_expiry_idx
    ON customer_invitations(expires_at)
    WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS invitation_redemptions_invitation_idx
    ON invitation_redemptions(invitation_id, redeemed_at DESC);

COMMIT;
