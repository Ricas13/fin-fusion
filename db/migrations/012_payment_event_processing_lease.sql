BEGIN;

ALTER TABLE payment_events
    ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS processing_token UUID;

CREATE INDEX IF NOT EXISTS payment_events_unprocessed_idx
    ON payment_events(created_at)
    WHERE processed_at IS NULL;

COMMIT;
