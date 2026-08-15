BEGIN;

-- Complete the upgrade bridge started by 035a. Migration 036 has now rebuilt
-- subscriptions_source_check, so make the already-supported invitation source
-- legal again before restoring the exact pre-existing invitation rows.
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

UPDATE subscriptions s
SET source='invitation'
FROM migration_036_invitation_source_bridge b
WHERE s.id=b.subscription_id
  AND s.source='migration';

DROP TABLE migration_036_invitation_source_bridge;

COMMIT;
