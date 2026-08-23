-- Final crypto-provider cleanup: Plisio is the only supported crypto checkout.
-- Unsupported historical crypto rows are anonymised to legacy_crypto so
-- accounting/audit history remains intact without keeping obsolete gateways.

ALTER TABLE payment_provider_credentials DROP CONSTRAINT IF EXISTS payment_provider_credentials_provider_check;
ALTER TABLE billing_checkout_intents DROP CONSTRAINT IF EXISTS billing_checkout_intents_provider_check;
ALTER TABLE payment_events DROP CONSTRAINT IF EXISTS payment_events_provider_check;
ALTER TABLE payment_incidents DROP CONSTRAINT IF EXISTS payment_incidents_provider_check;
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_source_check;

DELETE FROM payment_provider_credentials
WHERE provider NOT IN ('stripe','paypal','plisio');

UPDATE billing_checkout_intents SET provider='legacy_crypto',updated_at=NOW()
WHERE provider NOT IN ('stripe','paypal','plisio','legacy_crypto');
UPDATE payment_events SET provider='legacy_crypto'
WHERE provider NOT IN ('stripe','paypal','plisio','manual','legacy_crypto');
UPDATE payment_incidents SET provider='legacy_crypto',updated_at=NOW()
WHERE provider NOT IN ('stripe','paypal','plisio','legacy_crypto');
UPDATE subscriptions SET source='legacy_crypto',updated_at=NOW()
WHERE source NOT IN ('manual','stripe','paypal','plisio','legacy_crypto','migration','free_claim','admin_grant','invitation','service_credit');

ALTER TABLE payment_provider_credentials
  ADD CONSTRAINT payment_provider_credentials_provider_check
  CHECK (provider = ANY (ARRAY['stripe'::text,'paypal'::text,'plisio'::text]));

ALTER TABLE billing_checkout_intents
  ADD CONSTRAINT billing_checkout_intents_provider_check
  CHECK (provider = ANY (ARRAY['stripe'::text,'paypal'::text,'plisio'::text,'legacy_crypto'::text]));

ALTER TABLE payment_events
  ADD CONSTRAINT payment_events_provider_check
  CHECK (provider = ANY (ARRAY['stripe'::text,'paypal'::text,'plisio'::text,'manual'::text,'legacy_crypto'::text]));

ALTER TABLE payment_incidents
  ADD CONSTRAINT payment_incidents_provider_check
  CHECK (provider = ANY (ARRAY['stripe'::text,'paypal'::text,'plisio'::text,'legacy_crypto'::text]));

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_source_check
  CHECK (source = ANY (ARRAY[
    'manual'::text,
    'stripe'::text,
    'paypal'::text,
    'plisio'::text,
    'legacy_crypto'::text,
    'migration'::text,
    'free_claim'::text,
    'admin_grant'::text,
    'invitation'::text,
    'service_credit'::text
  ]));
