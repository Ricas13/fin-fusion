BEGIN;

CREATE TABLE admin_operator_read_cursors (
    admin_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    area text NOT NULL,
    seen_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (admin_user_id, area),
    CONSTRAINT admin_operator_read_cursor_area CHECK (area IN ('customers','orders','tickets'))
);

CREATE INDEX admin_operator_read_cursors_seen_idx
    ON admin_operator_read_cursors(admin_user_id, seen_at DESC);

COMMIT;
