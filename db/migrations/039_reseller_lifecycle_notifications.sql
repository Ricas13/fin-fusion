BEGIN;

CREATE TABLE IF NOT EXISTS reseller_notification_state (
    reseller_id UUID PRIMARY KEY REFERENCES resellers(id) ON DELETE CASCADE,
    subscription_status TEXT,
    tier_id UUID REFERENCES reseller_tiers(id) ON DELETE SET NULL,
    grace_active BOOLEAN NOT NULL DEFAULT FALSE,
    estate_suspended BOOLEAN NOT NULL DEFAULT FALSE,
    utilization_band INTEGER NOT NULL DEFAULT 0 CHECK (utilization_band IN (0,80,90,100)),
    initialized BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A reseller can receive several expiry warnings for the same downstream
-- entitlement (7d, 3d and 1d), but never the same threshold twice.  Keeping
-- this in PostgreSQL makes the observer safe across worker restarts/replicas.
CREATE TABLE IF NOT EXISTS reseller_customer_expiry_notices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reseller_id UUID NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    days_before INTEGER NOT NULL CHECK (days_before IN (1,3,7)),
    notified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(subscription_id, days_before)
);
CREATE INDEX IF NOT EXISTS reseller_customer_expiry_notices_reseller_idx
    ON reseller_customer_expiry_notices(reseller_id, notified_at DESC);

INSERT INTO automation_job_state(job_key,enabled,interval_seconds,next_run_at)
VALUES ('reseller_notifications',TRUE,300,NOW())
ON CONFLICT(job_key) DO NOTHING;

INSERT INTO notification_preferences(event_type) VALUES
 ('reseller.subscription.activated'),
 ('reseller.subscription.cancelled'),
 ('reseller.payment.failed'),
 ('reseller.grace.started'),
 ('reseller.estate.suspended'),
 ('reseller.estate.restored'),
 ('reseller.seat_usage'),
 ('reseller.tier.changed'),
 ('reseller.customer.expiring')
ON CONFLICT(event_type) DO NOTHING;

COMMIT;
