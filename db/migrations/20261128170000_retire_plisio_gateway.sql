BEGIN;

-- Plisio is no longer a supported checkout provider. New checkouts, callbacks,
-- re-checks and the background sweep are gone from the application.
--
-- Historical rows (subscriptions, checkout intents, payment events, incidents
-- and ledger transactions whose provider/source is 'plisio') are deliberately
-- left untouched: paid time already bought through Plisio keeps working, and
-- accounting/audit history stays intact. The provider CHECK constraints and
-- prepaid-time database functions therefore still accept 'plisio' as a
-- read-only, historical value.
--
-- The only data removed is the stored merchant secret, so no live credential
-- for the retired gateway remains in the database.
SET LOCAL lock_timeout = '5s';

DELETE FROM payment_provider_credentials WHERE provider = 'plisio';

COMMIT;
