BEGIN;

CREATE TABLE IF NOT EXISTS marketing_segments (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    name text NOT NULL,
    audience_filters jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT marketing_segments_name_length CHECK (char_length(name) BETWEEN 3 AND 160),
    CONSTRAINT marketing_segments_filters_object CHECK (jsonb_typeof(audience_filters)='object')
);

CREATE UNIQUE INDEX IF NOT EXISTS marketing_segments_name_unique_idx
    ON marketing_segments(LOWER(name));
CREATE INDEX IF NOT EXISTS marketing_segments_updated_idx
    ON marketing_segments(updated_at DESC);

ALTER TABLE marketing_campaigns
    ADD COLUMN IF NOT EXISTS segment_id uuid REFERENCES marketing_segments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS marketing_campaigns_segment_idx
    ON marketing_campaigns(segment_id);

COMMIT;
