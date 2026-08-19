BEGIN;

ALTER TABLE customer_communication_preferences
    ADD COLUMN IF NOT EXISTS marketing_email_opt_in boolean DEFAULT false NOT NULL,
    ADD COLUMN IF NOT EXISTS marketing_email_opted_in_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS marketing_email_opted_out_at timestamp with time zone;

CREATE TABLE marketing_campaigns (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    name text NOT NULL,
    subject text NOT NULL,
    body_text text NOT NULL,
    discount_code text,
    segment_key text NOT NULL DEFAULT 'no_active_subscription',
    status text NOT NULL DEFAULT 'draft',
    created_by_user_id uuid,
    recipient_count integer DEFAULT 0 NOT NULL,
    queued_count integer DEFAULT 0 NOT NULL,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT marketing_campaign_name_length CHECK (char_length(name) BETWEEN 3 AND 160),
    CONSTRAINT marketing_campaign_subject_length CHECK (char_length(subject) BETWEEN 3 AND 300),
    CONSTRAINT marketing_campaign_body_length CHECK (char_length(body_text) BETWEEN 1 AND 100000),
    CONSTRAINT marketing_campaign_segment CHECK (segment_key IN ('no_active_subscription','expired_subscription','all_opted_in')),
    CONSTRAINT marketing_campaign_status CHECK (status IN ('draft','queued','sent','cancelled'))
);

CREATE TABLE marketing_campaign_recipients (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    campaign_id uuid NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
    customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    email_snapshot text NOT NULL,
    display_name_snapshot text,
    status text NOT NULL DEFAULT 'pending',
    suppression_reason text,
    outbox_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    UNIQUE(campaign_id,customer_id),
    CONSTRAINT marketing_recipient_status CHECK (status IN ('pending','queued','suppressed'))
);

CREATE INDEX marketing_campaigns_created_idx ON marketing_campaigns(created_at DESC);
CREATE INDEX marketing_campaign_recipients_campaign_idx ON marketing_campaign_recipients(campaign_id,status);

COMMIT;
