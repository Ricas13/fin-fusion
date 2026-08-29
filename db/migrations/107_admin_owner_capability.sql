DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='app_users'
          AND column_name='is_owner'
    ) THEN
        ALTER TABLE public.app_users
            ADD COLUMN is_owner BOOLEAN NOT NULL DEFAULT FALSE;

        -- Existing administrators predate the owner/support split and retain
        -- their authority. Administrators created afterwards default to
        -- support-only unless an owner explicitly promotes them.
        UPDATE public.app_users
        SET is_owner=TRUE,
            updated_at=NOW()
        WHERE role='admin';
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_app_users_admin_owner
    ON app_users(is_owner)
    WHERE role='admin' AND active=TRUE;
