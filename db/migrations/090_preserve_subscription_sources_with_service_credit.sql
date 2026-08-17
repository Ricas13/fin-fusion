BEGIN;

-- Service credit is additive to the existing acquisition sources. Preserve all
-- previously-supported values when extending the CHECK constraint.
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
        'invitation',
        'service_credit'
    ));

COMMIT;
