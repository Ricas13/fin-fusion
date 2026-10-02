BEGIN;

ALTER TABLE payment_history_transactions
  DROP CONSTRAINT IF EXISTS payment_history_transactions_provider_check;
ALTER TABLE payment_history_transactions
  ADD CONSTRAINT payment_history_transactions_provider_check
  CHECK (provider IN ('stripe','paypal','plisio'));

COMMENT ON TABLE payment_history_transactions IS
'Canonical provider accounting ledger for Stripe, PayPal and Plisio. Rows are accounting/history only and never entitlement-authoritative.';

COMMIT;
