BEGIN;

-- The durable Jellyfin account creator is used by both interactive admin
-- recovery and the automation worker. The intent table was added after the
-- runtime roles had already been locked down, so neither runtime role inherited
-- privileges on the new table. That left a remote Jellyfin user safely created
-- but prevented Fin-Fusion from persisting/recovering the corresponding intent.
--
-- Keep this surgical: the table stores operational recovery state, so both
-- runtime actors need the same CRUD surface used by durable-account-creation.js.
DO $$
BEGIN
    IF to_regclass('public.jellyfin_account_creation_intents') IS NULL THEN
        RAISE EXCEPTION 'jellyfin_account_creation_intents must exist before applying runtime grants';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'steamfusion_app') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.jellyfin_account_creation_intents TO steamfusion_app';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'steamfusion_automation') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.jellyfin_account_creation_intents TO steamfusion_automation';
    END IF;
END $$;

COMMIT;
