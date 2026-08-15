BEGIN;

ALTER TABLE subscriptions
    DROP CONSTRAINT IF EXISTS subscriptions_source_check;

ALTER TABLE subscriptions
    ADD CONSTRAINT subscriptions_source_check
    CHECK (source IN ('manual','free_claim','reseller_credit','stripe','paypal','migration'));

COMMIT;
