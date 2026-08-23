-- Add CoinGate as a first-class one-time payment provider.
-- Keep this migration after the current provider/source constraint history so
-- clean installs and upgrades finish with CoinGate in the final allow-lists.
-- CoinGate does not use plan_provider_prices/payment_customers because orders are
-- created dynamically from CAPTAiNFiN's immutable local plan-price contract.

ALTER TABLE payment_provider_credentials
  DROP CONSTRAINT IF EXISTS payment_provider_credentials_provider_check;
ALTER TABLE payment_provider_credentials
  ADD CONSTRAINT payment_provider_credentials_provider_check
  CHECK (provider = ANY (ARRAY['stripe'::text, 'paypal'::text, 'coingate'::text]));

ALTER TABLE billing_checkout_intents
  DROP CONSTRAINT IF EXISTS billing_checkout_intents_provider_check;
ALTER TABLE billing_checkout_intents
  ADD CONSTRAINT billing_checkout_intents_provider_check
  CHECK (provider = ANY (ARRAY['stripe'::text, 'paypal'::text, 'coingate'::text]));

ALTER TABLE payment_events
  DROP CONSTRAINT IF EXISTS payment_events_provider_check;
ALTER TABLE payment_events
  ADD CONSTRAINT payment_events_provider_check
  CHECK (provider = ANY (ARRAY['stripe'::text, 'paypal'::text, 'coingate'::text, 'manual'::text]));

ALTER TABLE payment_incidents
  DROP CONSTRAINT IF EXISTS payment_incidents_provider_check;
ALTER TABLE payment_incidents
  ADD CONSTRAINT payment_incidents_provider_check
  CHECK (provider = ANY (ARRAY['stripe'::text, 'paypal'::text, 'coingate'::text]));

ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_source_check;
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_source_check
  CHECK (source = ANY (ARRAY[
    'manual'::text,
    'stripe'::text,
    'paypal'::text,
    'coingate'::text,
    'migration'::text,
    'free_claim'::text,
    'admin_grant'::text,
    'invitation'::text,
    'service_credit'::text
  ]));
