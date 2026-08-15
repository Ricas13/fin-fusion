BEGIN;

-- Invitation onboarding is a distinct acquisition path and writes
-- subscriptions.source='invitation'. Migration 036 rebuilt this CHECK while
-- adding newer sources but accidentally omitted the existing invitation source.
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_source_check;
ALTER TABLE subscriptions
    ADD CONSTRAINT subscriptions_source_check
    CHECK (source IN (
        'manual',
        'reseller_credit',
        'stripe',
        'paypal',
        'migration',
        'free_claim',
        'reseller_sale',
        'admin_grant',
        'invitation'
    ));

COMMIT;
