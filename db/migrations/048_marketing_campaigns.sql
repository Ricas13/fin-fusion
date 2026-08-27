BEGIN;

CREATE TABLE IF NOT EXISTS marketing_campaigns (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    name text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 160),
    subject text NOT NULL CHECK (char_length(subject) BETWEEN 3 AND 300),
    body_text text NOT NULL CHECK (char_length(body_text) BETWEEN 1 AND 100000),
    discount_code_id uuid REFERENCES discount_codes(id),
    audience_filters jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','queued','sent','cancelled')),
    scheduled_for timestamptz,
    schedule_next_attempt_at timestamptz,
    schedule_attempts integer NOT NULL DEFAULT 0,
    schedule_last_error text,
    recipient_count integer NOT NULL DEFAULT 0,
    queued_count integer NOT NULL DEFAULT 0,
    created_by_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
    queued_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketing_campaigns_created_idx ON marketing_campaigns(created_at DESC);
CREATE INDEX IF NOT EXISTS marketing_campaigns_due_schedule_idx ON marketing_campaigns(COALESCE(schedule_next_attempt_at,scheduled_for)) WHERE status='scheduled';

CREATE TABLE IF NOT EXISTS marketing_campaign_recipients (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    campaign_id uuid NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
    customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    email_snapshot text,
    display_name_snapshot text,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','queued','suppressed')),
    suppression_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(campaign_id,customer_id)
);
CREATE INDEX IF NOT EXISTS marketing_campaign_recipients_campaign_idx ON marketing_campaign_recipients(campaign_id,status);

CREATE TABLE IF NOT EXISTS marketing_campaign_deliveries (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    campaign_id uuid NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
    customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    channel text NOT NULL CHECK (channel IN ('email','telegram','discord','whatsapp')),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','queued','suppressed','failed')),
    suppression_reason text,
    outbox_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(campaign_id,customer_id,channel)
);
CREATE INDEX IF NOT EXISTS marketing_campaign_deliveries_campaign_idx ON marketing_campaign_deliveries(campaign_id,status);

COMMIT;
