-- Persistent administrator intent for Jellyfin access.
--
-- Normal placement and lifecycle automation may decide where/when a customer
-- receives Jellyfin access. An explicit administrator command is different:
-- it must remain authoritative until the administrator returns the customer to
-- automatic management. The control is scoped to the exact subscription so a
-- later plan change starts cleanly instead of inheriting stale operator intent.

CREATE TABLE IF NOT EXISTS customer_jellyfin_admin_control (
    customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    mode text NOT NULL CHECK (mode IN ('forced_server', 'removed')),
    server_id uuid REFERENCES jellyfin_servers(id) ON DELETE RESTRICT,
    reason text NOT NULL DEFAULT '',
    created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (customer_id, subscription_id),
    CONSTRAINT customer_jellyfin_admin_control_server_mode CHECK (
        (mode='forced_server' AND server_id IS NOT NULL)
        OR (mode='removed' AND server_id IS NULL)
    ),
    CONSTRAINT customer_jellyfin_admin_control_reason_length CHECK (length(reason) <= 500)
);

CREATE INDEX IF NOT EXISTS customer_jellyfin_admin_control_server_idx
    ON customer_jellyfin_admin_control(server_id)
    WHERE mode='forced_server';

COMMENT ON TABLE customer_jellyfin_admin_control IS
'Explicit Jellyfin operator intent. forced_server bypasses automatic placement/capacity; removed prevents automation from recreating access until cleared.';
