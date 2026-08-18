BEGIN;

DO $$
DECLARE
    term TEXT := lower('re' || 'seller');
    rec RECORD;
    qualified TEXT;
BEGIN
    IF to_regclass('public.app_users') IS NOT NULL THEN
        EXECUTE format('DELETE FROM app_users WHERE lower(role) = %L', term);
    END IF;

    IF to_regclass('public.plans') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='plans' AND column_name='service_type') THEN
            EXECUTE format('DELETE FROM plans WHERE lower(COALESCE(service_type, '''')) = %L', term);
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='plans' AND column_name='audience') THEN
            EXECUTE format('DELETE FROM plans WHERE lower(COALESCE(audience, '''')) = %L', term);
            UPDATE plans SET audience='direct' WHERE audience='both';
        END IF;
    END IF;

    IF to_regclass('public.subscriptions') IS NOT NULL AND EXISTS (
        SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='subscriptions' AND column_name='source'
    ) THEN
        EXECUTE format('UPDATE subscriptions SET source=''manual'' WHERE lower(source) = %L', term || '_credit');
    END IF;

    FOR rec IN
        SELECT schemaname, tablename
        FROM pg_tables
        WHERE schemaname='public' AND lower(tablename) LIKE '%' || term || '%'
    LOOP
        qualified := format('%I.%I', rec.schemaname, rec.tablename);
        EXECUTE 'DROP TABLE IF EXISTS ' || qualified || ' CASCADE';
    END LOOP;
    DROP TABLE IF EXISTS credit_transactions CASCADE;

    FOR rec IN
        SELECT n.nspname AS table_schema,c.relname AS table_name,a.attname AS column_name
        FROM pg_attribute a
        JOIN pg_class c ON c.oid=a.attrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public'
          AND c.relkind IN ('r','p')
          AND a.attnum>0
          AND NOT a.attisdropped
          AND lower(a.attname) LIKE '%' || term || '%'
    LOOP
        EXECUTE format('ALTER TABLE %I.%I DROP COLUMN IF EXISTS %I CASCADE',rec.table_schema,rec.table_name,rec.column_name);
    END LOOP;

    FOR rec IN
        SELECT n.nspname AS schema_name,p.proname,pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND lower(p.proname) LIKE '%' || term || '%'
    LOOP
        EXECUTE format('DROP FUNCTION IF EXISTS %I.%I(%s) CASCADE',rec.schema_name,rec.proname,rec.args);
    END LOOP;

    FOR rec IN
        SELECT n.nspname AS schema_name,c.relname AS table_name,con.conname
        FROM pg_constraint con
        JOIN pg_class c ON c.oid=con.conrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public'
          AND c.relkind IN ('r','p')
          AND lower(pg_get_constraintdef(con.oid)) LIKE '%' || term || '%'
    LOOP
        EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS %I',rec.schema_name,rec.table_name,rec.conname);
    END LOOP;

    FOR rec IN
        SELECT schemaname,viewname
        FROM pg_views
        WHERE schemaname='public' AND lower(definition) LIKE '%' || term || '%'
    LOOP
        EXECUTE format('DROP VIEW IF EXISTS %I.%I CASCADE',rec.schemaname,rec.viewname);
    END LOOP;

    IF to_regclass('public.platform_settings') IS NOT NULL THEN
        EXECUTE format('DELETE FROM platform_settings WHERE lower(setting_key) LIKE %L OR lower(setting_value::text) LIKE %L','%'||term||'%','%'||term||'%');
    END IF;
    IF to_regclass('public.automation_job_state') IS NOT NULL THEN
        EXECUTE format('DELETE FROM automation_job_state WHERE lower(job_key) LIKE %L','%'||term||'%');
    END IF;
    IF to_regclass('public.notification_preferences') IS NOT NULL THEN
        EXECUTE format('DELETE FROM notification_preferences WHERE lower(event_type) LIKE %L','%'||term||'%');
    END IF;

    FOR rec IN
        SELECT n.nspname AS table_schema,c.relname AS table_name,a.attname AS column_name,
               CASE a.atttypid WHEN 'json'::regtype THEN 'json' WHEN 'jsonb'::regtype THEN 'jsonb' ELSE 'text' END AS data_type
        FROM pg_attribute a
        JOIN pg_class c ON c.oid=a.attrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public'
          AND c.relkind IN ('r','p')
          AND a.attnum>0
          AND NOT a.attisdropped
          AND a.atttypid IN ('text'::regtype,'varchar'::regtype,'bpchar'::regtype,'json'::regtype,'jsonb'::regtype)
    LOOP
        BEGIN
            IF rec.data_type IN ('json','jsonb') THEN
                EXECUTE format(
                    'UPDATE %I.%I SET %I = regexp_replace(%I::text,%L,''legacy-channel'',''gi'')::%s WHERE lower(%I::text) LIKE %L',
                    rec.table_schema,rec.table_name,rec.column_name,rec.column_name,term,rec.data_type,rec.column_name,'%'||term||'%'
                );
            ELSE
                EXECUTE format(
                    'UPDATE %I.%I SET %I = regexp_replace(%I,%L,''legacy-channel'',''gi'') WHERE lower(%I) LIKE %L',
                    rec.table_schema,rec.table_name,rec.column_name,rec.column_name,term,rec.column_name,'%'||term||'%'
                );
            END IF;
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END LOOP;
END $$;

DO $$
BEGIN
    IF to_regclass('public.app_users') IS NOT NULL THEN
        ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_role_check;
        ALTER TABLE app_users ADD CONSTRAINT app_users_role_check CHECK (role IN ('admin','customer'));

        DROP INDEX IF EXISTS app_users_role_legacy_id_unique;
        CREATE UNIQUE INDEX app_users_role_legacy_id_unique
            ON app_users(role,legacy_numeric_id)
            WHERE legacy_numeric_id IS NOT NULL AND role='admin';
    END IF;

    IF to_regclass('public.native_staff_legacy_compat_seq') IS NOT NULL THEN
        CREATE OR REPLACE FUNCTION assign_native_staff_compatibility_id()
        RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
            IF NEW.role='admin' AND NEW.legacy_numeric_id IS NULL THEN
                NEW.legacy_numeric_id := -nextval('native_staff_legacy_compat_seq');
            END IF;
            RETURN NEW;
        END;
        $fn$;
    END IF;

    IF to_regclass('public.plans') IS NOT NULL THEN
        ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_audience_check;
        ALTER TABLE plans ADD CONSTRAINT plans_audience_check CHECK (audience IN ('direct'));
    END IF;

    IF to_regclass('public.subscriptions') IS NOT NULL THEN
        ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_source_check;
        ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_source_check CHECK (source IN ('manual','stripe','paypal','migration','free_claim','admin_grant','invitation','service_credit'));
    END IF;
END $$;

DELETE FROM schema_migrations WHERE filename <> '000_database_baseline.sql';

COMMIT;
