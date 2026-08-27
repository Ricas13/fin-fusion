BEGIN;

-- migration 018 removed the marketing_campaigns automation job-state row but
-- never dropped the tables migration 013 created, so they still exist on
-- every install with their original shape (free-text discount_code, a fixed
-- segment_key enum). Reconcile that pre-existing table into the new shape
-- (a real discount_codes FK, and jsonb audience_filters reusing
-- customer-filters.js's filter shape) instead of creating a fresh one.

ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS discount_code_id uuid REFERENCES discount_codes(id);
UPDATE marketing_campaigns mc SET discount_code_id=dc.id
    FROM discount_codes dc
    WHERE dc.code=mc.discount_code AND mc.discount_code_id IS NULL AND mc.discount_code IS NOT NULL;
ALTER TABLE marketing_campaigns DROP COLUMN IF EXISTS discount_code;

ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS audience_filters jsonb NOT NULL DEFAULT '{}'::jsonb;
UPDATE marketing_campaigns SET audience_filters=CASE segment_key
        WHEN 'no_active_subscription' THEN '{"status":"none"}'::jsonb
        WHEN 'expired_subscription' THEN '{"status":"expired"}'::jsonb
        ELSE '{}'::jsonb
    END
    WHERE audience_filters='{}'::jsonb AND segment_key IS NOT NULL;
ALTER TABLE marketing_campaigns DROP CONSTRAINT IF EXISTS marketing_campaign_segment;
ALTER TABLE marketing_campaigns DROP COLUMN IF EXISTS segment_key;

CREATE INDEX IF NOT EXISTS marketing_campaigns_created_idx ON marketing_campaigns(created_at DESC);
CREATE INDEX IF NOT EXISTS marketing_campaigns_due_schedule_idx ON marketing_campaigns(COALESCE(schedule_next_attempt_at,scheduled_for)) WHERE status='scheduled';

-- Recipients: allow a customer with no email on file (delivered only over
-- their other linked channels) instead of requiring email_snapshot.
ALTER TABLE marketing_campaign_recipients ALTER COLUMN email_snapshot DROP NOT NULL;
CREATE INDEX IF NOT EXISTS marketing_campaign_recipients_campaign_idx ON marketing_campaign_recipients(campaign_id,status);

-- Deliveries: genuinely new, a per-(campaign,customer,channel) send ledger
-- matching this codebase's established notification-preference pattern.
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
