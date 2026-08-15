BEGIN;

CREATE TABLE IF NOT EXISTS reseller_notification_state (
    reseller_id UUID PRIMARY KEY REFERENCES resellers(id) ON DELETE CASCADE,
    subscription_status TEXT,
    grace_active BOOLEAN NOT NULL DEFAULT FALSE,
    estate_suspended BOOLEAN NOT NULL DEFAULT FALSE,
    utilization_band INTEGER NOT NULL DEFAULT 0 CHECK (utilization_band IN (0,80,90,100)),
    initialized BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
 ('reseller.seat_usage')
ON CONFLICT(event_type) DO NOTHING;

COMMIT;
