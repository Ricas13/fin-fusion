BEGIN;

ALTER TABLE marketing_campaigns
    ADD COLUMN IF NOT EXISTS segment_rules jsonb DEFAULT '{}'::jsonb NOT NULL;

ALTER TABLE marketing_campaigns
    DROP CONSTRAINT IF EXISTS marketing_campaign_segment_rules_object;
ALTER TABLE marketing_campaigns
    ADD CONSTRAINT marketing_campaign_segment_rules_object
    CHECK (jsonb_typeof(segment_rules)='object');

ALTER TABLE marketing_campaigns
    DROP CONSTRAINT IF EXISTS marketing_campaign_segment;
ALTER TABLE marketing_campaigns
    ADD CONSTRAINT marketing_campaign_segment
    CHECK (segment_key IN ('no_active_subscription','expired_subscription','active_subscription','all_opted_in'));

CREATE TABLE IF NOT EXISTS marketing_segments (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    name text NOT NULL,
    base_segment_key text NOT NULL DEFAULT 'all_opted_in',
    rules jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT marketing_segment_name_length CHECK (char_length(name) BETWEEN 3 AND 160),
    CONSTRAINT marketing_segment_base_key CHECK (base_segment_key IN ('no_active_subscription','expired_subscription','active_subscription','all_opted_in')),
    CONSTRAINT marketing_segment_rules_object CHECK (jsonb_typeof(rules)='object')
);

CREATE UNIQUE INDEX IF NOT EXISTS marketing_segments_name_unique_idx
    ON marketing_segments(LOWER(name));
CREATE INDEX IF NOT EXISTS marketing_segments_updated_idx
    ON marketing_segments(updated_at DESC);

CREATE TABLE IF NOT EXISTS marketing_templates (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    name text NOT NULL,
    subject text NOT NULL,
    body_text text NOT NULL,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT marketing_template_name_length CHECK (char_length(name) BETWEEN 3 AND 160),
    CONSTRAINT marketing_template_subject_length CHECK (char_length(subject) BETWEEN 3 AND 300),
    CONSTRAINT marketing_template_body_length CHECK (char_length(body_text) BETWEEN 1 AND 100000)
);

CREATE UNIQUE INDEX IF NOT EXISTS marketing_templates_name_unique_idx
    ON marketing_templates(LOWER(name));
CREATE INDEX IF NOT EXISTS marketing_templates_updated_idx
    ON marketing_templates(updated_at DESC);

ALTER TABLE marketing_campaigns
    ADD COLUMN IF NOT EXISTS segment_id uuid REFERENCES marketing_segments(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS template_id uuid REFERENCES marketing_templates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS marketing_campaigns_segment_idx
    ON marketing_campaigns(segment_id);
CREATE INDEX IF NOT EXISTS marketing_campaigns_template_idx
    ON marketing_campaigns(template_id);

COMMIT;
