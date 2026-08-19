BEGIN;

-- Per-admin dashboard widget layout (order/span/visibility/config). Defaults live in
-- the widget registry (code), not in this table, so a code change to a widget's
-- default span never needs a migration. "Reset to default" is simply deleting the
-- admin's rows for that dashboard.
CREATE TABLE public.admin_dashboard_widget_layout (
    admin_user_id uuid NOT NULL,
    dashboard_key text NOT NULL,
    widget_key text NOT NULL,
    position integer NOT NULL,
    span integer NOT NULL DEFAULT 6,
    visible boolean NOT NULL DEFAULT TRUE,
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT admin_dashboard_widget_layout_pkey PRIMARY KEY (admin_user_id, dashboard_key, widget_key),
    CONSTRAINT admin_dashboard_widget_layout_dashboard_key_check
        CHECK (dashboard_key = ANY (ARRAY['main'::text,'users'::text,'commerce'::text,'servers'::text])),
    CONSTRAINT admin_dashboard_widget_layout_span_check
        CHECK (span = ANY (ARRAY[3,4,6,8,9,12]))
);

ALTER TABLE ONLY public.admin_dashboard_widget_layout
    ADD CONSTRAINT admin_dashboard_widget_layout_admin_user_id_fkey
    FOREIGN KEY (admin_user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;

CREATE INDEX admin_dashboard_widget_layout_lookup_idx
    ON public.admin_dashboard_widget_layout USING btree (admin_user_id, dashboard_key, position);

COMMIT;
