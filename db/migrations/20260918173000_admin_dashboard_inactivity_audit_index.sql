-- Keep the admin Home automation feed bounded as the append-only audit log grows.
-- This index covers only automated Free inactivity outcomes surfaced by the
-- dashboard; it is intentionally narrower than a general audit-history index.

CREATE INDEX IF NOT EXISTS audit_log_dashboard_inactivity_recent_idx
    ON public.audit_log (created_at DESC, id DESC)
    WHERE actor_user_id IS NULL
      AND entity_type='customer'
      AND action IN (
        'customer.inactivity.remove_jellyfin',
        'customer.inactivity.remove_failed',
        'customer.inactivity.would_remove_jellyfin'
      );
