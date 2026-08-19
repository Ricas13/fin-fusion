BEGIN;

ALTER TABLE marketing_campaigns
    ADD COLUMN IF NOT EXISTS segment_rules jsonb DEFAULT '{}'::jsonb NOT NULL;

ALTER TABLE marketing_campaigns
    ADD CONSTRAINT marketing_campaign_segment_rules_object
    CHECK (jsonb_typeof(segment_rules)='object');

COMMIT;
