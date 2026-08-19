BEGIN;

ALTER TABLE marketing_campaigns
    ADD COLUMN IF NOT EXISTS scheduled_for timestamp with time zone,
    ADD COLUMN IF NOT EXISTS schedule_next_attempt_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS schedule_attempts integer DEFAULT 0 NOT NULL,
    ADD COLUMN IF NOT EXISTS schedule_last_error text;

ALTER TABLE marketing_campaigns
    DROP CONSTRAINT IF EXISTS marketing_campaign_status;

ALTER TABLE marketing_campaigns
    ADD CONSTRAINT marketing_campaign_status
    CHECK (status IN ('draft','scheduled','queued','sent','cancelled'));

CREATE INDEX IF NOT EXISTS marketing_campaigns_due_schedule_idx
    ON marketing_campaigns(COALESCE(schedule_next_attempt_at,scheduled_for))
    WHERE status='scheduled';

COMMIT;
