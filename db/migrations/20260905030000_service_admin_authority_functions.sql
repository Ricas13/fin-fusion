BEGIN;

-- Composable admin-authority primitives so automatic Jellyfin/Stremio
-- eligibility queries respect an active administrator directive
-- (customer_service_admin_control) the same way the Jellyfin primary lane
-- already (partially) respected the legacy permanent_access override.
-- "No automated process may mutate a service contrary to an active admin
-- directive."
--
-- subscription_admin_present: TRUE if this exact subscription is pinned by
-- the legacy permanent_access override, OR the customer has an active
-- admin_present/admin_server_pin directive for this service (service-scoped,
-- so it applies regardless of which subscription row automation is
-- currently evaluating).
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
            SELECT 1 FROM public.customer_entitlement_overrides o
            WHERE o.customer_id=p_customer_id AND o.subscription_id=p_subscription_id
              AND o.permanent_access=TRUE AND o.revoked_at IS NULL
        )
        OR EXISTS(
            SELECT 1 FROM public.customer_service_admin_control c
            WHERE c.customer_id=p_customer_id AND c.service=p_service
              AND c.mode IN ('admin_present','admin_server_pin')
        );
$$;

-- subscription_admin_removed: TRUE if the customer has an active
-- admin_removed directive for this service. This must force access absent
-- even if the subscription itself is otherwise perfectly valid (a
-- subsequent successful payment must not silently defeat it).
CREATE OR REPLACE FUNCTION public.subscription_admin_removed(
    p_customer_id uuid,
    p_service text
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS(
        SELECT 1 FROM public.customer_service_admin_control c
        WHERE c.customer_id=p_customer_id AND c.service=p_service AND c.mode='admin_removed'
    );
$$;

-- Stremio's effective-entitlement view previously computed `blocked` purely
-- from customer_access_holds via subscription_access_blocked(), with no
-- admin-authority bypass at all (unlike the Jellyfin primary lane's inline
-- query in subscription-state.js, which already exempted an active
-- permanent_access override). An admin directive must win here too, and
-- must also be able to keep an otherwise-expired subscription eligible
-- (mirroring how permanent_access already does), so a forced removal or a
-- forced grant is not defeated by ordinary expiry/renewal timing.
CREATE OR REPLACE VIEW effective_stremio_entitlements AS
 SELECT DISTINCT ON (s.customer_id)
    s.customer_id,
    s.id AS subscription_id,
    s.plan_id,
    s.status,
    s.source,
    s.starts_at,
    s.current_period_end,
    CASE WHEN (o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id)
              OR public.subscription_admin_present(s.customer_id,'stremio',s.id)
         THEN 'infinity'::timestamptz
         ELSE (s.current_period_end + ((COALESCE(s.service_extension_days,0) || ' days'::text))::interval)
    END AS access_expires_at,
    s.cancel_at_period_end,
    s.provider_customer_id,
    s.provider_subscription_id,
    (public.subscription_admin_removed(s.customer_id,'stremio')
        OR (public.subscription_access_blocked(s.customer_id,s.source,s.provider_subscription_id)
            AND NOT public.subscription_admin_present(s.customer_id,'stremio',s.id))) AS blocked,
    s.service_type_snapshot,
    p.service_type,
    p.is_addon,
    p.is_free_tier,
    p.name,
    p.code,
    p.streams
 FROM subscriptions s
 JOIN plans p ON p.id=s.plan_id
 LEFT JOIN customer_entitlement_overrides o ON o.customer_id=s.customer_id AND o.subscription_id=s.id
 WHERE COALESCE(p.is_addon,FALSE)=FALSE
   AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('stremio','bundle')
   AND s.superseded_by IS NULL
   AND s.starts_at<=NOW()
   AND (
      (o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id)
      OR public.subscription_admin_present(s.customer_id,'stremio',s.id)
      OR (s.status IN ('active','trialing','past_due','paused') AND s.current_period_end>NOW())
      OR (COALESCE(s.service_extension_days,0)>0 AND s.status IN ('active','trialing','past_due','paused','cancelled','expired') AND (s.current_period_end + ((s.service_extension_days || ' days'::text))::interval)>NOW())
   )
 ORDER BY s.customer_id,
   (public.subscription_admin_removed(s.customer_id,'stremio')
        OR (public.subscription_access_blocked(s.customer_id,s.source,s.provider_subscription_id)
            AND NOT public.subscription_admin_present(s.customer_id,'stremio',s.id))) ASC,
   (CASE WHEN (o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id)
              OR public.subscription_admin_present(s.customer_id,'stremio',s.id)
         THEN 'infinity'::timestamptz
         ELSE (s.current_period_end + ((COALESCE(s.service_extension_days,0) || ' days'::text))::interval) END) DESC,
   s.created_at DESC;

COMMENT ON VIEW effective_stremio_entitlements IS 'Effective standalone Stremio/bundle primary entitlement, independent of Jellyfin primary access. blocked also respects service-scoped administrator authority (customer_service_admin_control), and an admin_present/admin_server_pin directive keeps an otherwise-expired subscription eligible the same way permanent_access already does.';

COMMIT;
