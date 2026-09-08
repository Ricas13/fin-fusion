BEGIN;

-- Durable safety net for customer-access mutations.
--
-- Application paths should still reconcile immediately. These triggers exist so
-- a future code path that commits entitlement truth but forgets to call the
-- reconciler cannot leave the customer stranded indefinitely.
ALTER TABLE customer_provisioning_state
    ADD COLUMN IF NOT EXISTS reconcile_requested_at timestamptz;

COMMENT ON COLUMN customer_provisioning_state.reconcile_requested_at IS
'Newest entitlement-authority change that must be consumed by a reconciliation run. Cleared when a run starts; if another change lands while that run is in progress, completion requeues the customer.';

CREATE OR REPLACE FUNCTION public.request_customer_entitlement_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    target_customer_id uuid;
BEGIN
    target_customer_id := COALESCE(NEW.customer_id, OLD.customer_id);
    IF target_customer_id IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Customer deletion can cascade through entitlement tables. Do not recreate
    -- provisioning state for a customer that is itself disappearing.
    IF NOT EXISTS (SELECT 1 FROM customers c WHERE c.id=target_customer_id) THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    INSERT INTO customer_provisioning_state(
        customer_id,status,next_attempt_at,reconcile_requested_at,updated_at
    ) VALUES(
        target_customer_id,'pending',NOW(),NOW(),NOW()
    )
    ON CONFLICT (customer_id) DO UPDATE SET
        reconcile_requested_at=NOW(),
        status=CASE
            WHEN customer_provisioning_state.status='running' THEN 'running'
            ELSE 'pending'
        END,
        next_attempt_at=CASE
            WHEN customer_provisioning_state.status='running'
                THEN COALESCE(customer_provisioning_state.next_attempt_at, NOW()+INTERVAL '15 minutes')
            ELSE NOW()
        END,
        updated_at=NOW();

    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS subscriptions_request_entitlement_reconciliation ON subscriptions;
CREATE TRIGGER subscriptions_request_entitlement_reconciliation
AFTER INSERT OR DELETE OR UPDATE OF
    customer_id,
    plan_id,
    status,
    starts_at,
    current_period_end,
    service_extension_days,
    superseded_by,
    commercial_snapshot,
    service_type_snapshot
ON subscriptions
FOR EACH ROW
EXECUTE FUNCTION public.request_customer_entitlement_reconciliation();

DROP TRIGGER IF EXISTS entitlement_overrides_request_reconciliation ON customer_entitlement_overrides;
CREATE TRIGGER entitlement_overrides_request_reconciliation
AFTER INSERT OR DELETE OR UPDATE OF
    customer_id,
    subscription_id,
    permanent_access,
    revoked_at
ON customer_entitlement_overrides
FOR EACH ROW
EXECUTE FUNCTION public.request_customer_entitlement_reconciliation();

DROP TRIGGER IF EXISTS access_holds_request_entitlement_reconciliation ON customer_access_holds;
CREATE TRIGGER access_holds_request_entitlement_reconciliation
AFTER INSERT OR DELETE OR UPDATE OF
    customer_id,
    released_at
ON customer_access_holds
FOR EACH ROW
EXECUTE FUNCTION public.request_customer_entitlement_reconciliation();

DROP TRIGGER IF EXISTS service_admin_control_request_reconciliation ON customer_service_admin_control;
CREATE TRIGGER service_admin_control_request_reconciliation
AFTER INSERT OR DELETE OR UPDATE OF
    customer_id,
    service,
    mode,
    server_id
ON customer_service_admin_control
FOR EACH ROW
EXECUTE FUNCTION public.request_customer_entitlement_reconciliation();

COMMIT;
