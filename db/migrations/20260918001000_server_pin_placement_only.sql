BEGIN;

-- A server pin chooses WHERE Jellyfin access lives. It must never decide
-- WHETHER access exists. Historically subscription_admin_present() treated
-- admin_server_pin as equivalent to admin_present, which let a placement pin
-- bypass expiry and customer access holds (including Free inactivity holds).
--
-- Keep Permanent Access and explicit admin_present as entitlement authority.
-- Remove admin_server_pin from that authority completely.
CREATE OR REPLACE FUNCTION public.subscription_admin_present(
    p_customer_id uuid,
    p_service text,
    p_subscription_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT
        EXISTS(
            SELECT 1
            FROM public.customer_entitlement_overrides o
            WHERE o.customer_id=p_customer_id
              AND o.subscription_id=p_subscription_id
              AND o.permanent_access=TRUE
              AND o.revoked_at IS NULL
        )
        OR EXISTS(
            SELECT 1
            FROM public.customer_service_admin_control c
            WHERE c.customer_id=p_customer_id
              AND c.service=p_service
              AND c.mode='admin_present'
        );
$$;

COMMENT ON FUNCTION public.subscription_admin_present(uuid,text,uuid)
IS 'True only for explicit access authority (Permanent Access or admin_present). admin_server_pin is placement-only and never grants, preserves, or unblocks entitlement.';

COMMIT;
