-- Make Plisio the active crypto provider without invalidating historical or
-- in-flight CoinGate records. CoinGate remains in database allow-lists solely
-- for compatibility; new customer checkout is not exposed through CoinGate.

ALTER TABLE payment_provider_credentials
  DROP CONSTRAINT IF EXISTS payment_provider_credentials_provider_check;
ALTER TABLE payment_provider_credentials
  ADD CONSTRAINT payment_provider_credentials_provider_check
  CHECK (provider = ANY (ARRAY['stripe'::text, 'paypal'::text, 'coingate'::text, 'plisio'::text]));

ALTER TABLE billing_checkout_intents
  DROP CONSTRAINT IF EXISTS billing_checkout_intents_provider_check;
ALTER TABLE billing_checkout_intents
  ADD CONSTRAINT billing_checkout_intents_provider_check
  CHECK (provider = ANY (ARRAY['stripe'::text, 'paypal'::text, 'coingate'::text, 'plisio'::text]));

ALTER TABLE payment_events
  DROP CONSTRAINT IF EXISTS payment_events_provider_check;
ALTER TABLE payment_events
  ADD CONSTRAINT payment_events_provider_check
  CHECK (provider = ANY (ARRAY['stripe'::text, 'paypal'::text, 'coingate'::text, 'plisio'::text, 'manual'::text]));

ALTER TABLE payment_incidents
  DROP CONSTRAINT IF EXISTS payment_incidents_provider_check;
ALTER TABLE payment_incidents
  ADD CONSTRAINT payment_incidents_provider_check
  CHECK (provider = ANY (ARRAY['stripe'::text, 'paypal'::text, 'coingate'::text, 'plisio'::text]));

ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_source_check;
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_source_check
  CHECK (source = ANY (ARRAY[
    'manual'::text,
    'stripe'::text,
    'paypal'::text,
    'coingate'::text,
    'plisio'::text,
    'migration'::text,
    'free_claim'::text,
    'admin_grant'::text,
    'invitation'::text,
    'service_credit'::text
  ]));
