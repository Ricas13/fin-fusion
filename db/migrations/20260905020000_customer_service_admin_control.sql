BEGIN;

-- Canonical, service-scoped administrator authority, generalized from the
-- Jellyfin-only, subscription-scoped customer_jellyfin_admin_control.
--
-- The legacy table keyed authority to a specific subscription row, so an
-- admin directive silently stopped applying the moment that subscription was
-- superseded (a plan change, a renewal, a new checkout after a payment
-- failure) - exactly the kind of "temporary bypass" the canonical model must
-- not be. Authority here is scoped to (customer_id, service) instead: it
-- persists across subscription/payment churn until an administrator
-- explicitly returns the customer to automatic management, regardless of
-- which entitlement row automation is currently looking at.
CREATE TABLE IF NOT EXISTS customer_service_admin_control (
    customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    service text NOT NULL CHECK (service IN ('jellyfin', 'stremio', 'overseerr')),
    mode text NOT NULL CHECK (mode IN ('admin_present', 'admin_removed', 'admin_server_pin')),
    server_id uuid REFERENCES jellyfin_servers(id) ON DELETE RESTRICT,
    reason text NOT NULL DEFAULT '',
    created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (customer_id, service),
    CONSTRAINT customer_service_admin_control_server_mode CHECK (
        (mode = 'admin_server_pin' AND server_id IS NOT NULL AND service = 'jellyfin')
        OR (mode <> 'admin_server_pin' AND server_id IS NULL)
    ),
    CONSTRAINT customer_service_admin_control_reason_length CHECK (length(reason) <= 500)
);

CREATE INDEX IF NOT EXISTS customer_service_admin_control_server_idx
    ON customer_service_admin_control(server_id)
    WHERE mode = 'admin_server_pin';

COMMENT ON TABLE customer_service_admin_control IS
'Canonical, service-scoped (not subscription-scoped) administrator authority. admin_present/admin_removed override every automatic commercial/free-tier access decision for that service; admin_server_pin additionally bypasses automatic Jellyfin placement. No automated process may mutate a service contrary to an active row here; it persists until an administrator explicitly clears it (return to automatic management).';

-- Backfill from the legacy table. A customer may have accumulated rows
-- against superseded subscriptions under the old subscription-scoped design;
-- only the most recently updated row per customer is the operative directive.
INSERT INTO customer_service_admin_control(customer_id, service, mode, server_id, reason, created_by, created_at, updated_by, updated_at)
SELECT DISTINCT ON (customer_id)
    customer_id,
    'jellyfin',
    CASE mode WHEN 'forced_server' THEN 'admin_server_pin' WHEN 'removed' THEN 'admin_removed' ELSE mode END,
    server_id,
    reason,
    created_by,
    created_at,
    updated_by,
    updated_at
FROM customer_jellyfin_admin_control
ORDER BY customer_id, updated_at DESC
ON CONFLICT (customer_id, service) DO NOTHING;

COMMENT ON TABLE customer_jellyfin_admin_control IS
'Deprecated: superseded by customer_service_admin_control (customer+service scoped, not subscription-scoped). Retained for one release as a rollback safety net; application code no longer reads or writes it as of this migration.';

COMMIT;
