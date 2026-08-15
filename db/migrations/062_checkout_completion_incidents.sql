BEGIN;

-- Provider payment can succeed while the local checkout-intent bookkeeping
-- fails. Treat that as a first-class payment incident instead of swallowing it
-- in the webhook router; this keeps the provider-success/local-failure boundary
-- visible in Commerce / Needs Attention and auditable.
ALTER TABLE payment_incidents
    DROP CONSTRAINT IF EXISTS payment_incidents_incident_type_check;
ALTER TABLE payment_incidents
    ADD CONSTRAINT payment_incidents_incident_type_check
    CHECK (incident_type IN ('refund','dispute','chargeback','failed_renewal','checkout_completion'));

COMMIT;
