-- Customer-paid same-plan extensions use the existing service-extension ledger.
-- A calendar year can span 366 days, so allow one event to represent that
-- exact purchased period while retaining the aggregate 3,650-day safety cap.
BEGIN;

ALTER TABLE public.subscription_service_extension_events
  DROP CONSTRAINT IF EXISTS subscription_service_extension_events_days_check;

ALTER TABLE public.subscription_service_extension_events
  ADD CONSTRAINT subscription_service_extension_events_days_check
  CHECK (days > 0 AND days <= 366);

COMMENT ON TABLE public.subscription_service_extension_events IS
  'Auditable service-time extensions. Customer-paid events use source customer_paid_extension:<provider>; their calendar duration is re-based after provider renewals without creating another subscription or consuming another server place.';

COMMIT;
