BEGIN;

-- legacy_numeric_id is compatibility metadata, not the authoritative identity.
-- Allocate negative IDs for PostgreSQL-native staff so older compatibility gates
-- remain non-null without ever colliding with historical positive legacy rows.
CREATE SEQUENCE IF NOT EXISTS native_staff_legacy_compat_seq START WITH 1 INCREMENT BY 1;

UPDATE app_users
SET legacy_numeric_id = -nextval('native_staff_legacy_compat_seq')
WHERE role IN ('admin','reseller') AND legacy_numeric_id IS NULL;

CREATE OR REPLACE FUNCTION assign_native_staff_compatibility_id()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.role IN ('admin','reseller') AND NEW.legacy_numeric_id IS NULL THEN
        NEW.legacy_numeric_id := -nextval('native_staff_legacy_compat_seq');
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assign_native_staff_compatibility_id_trigger ON app_users;
CREATE TRIGGER assign_native_staff_compatibility_id_trigger
BEFORE INSERT OR UPDATE OF role ON app_users
FOR EACH ROW EXECUTE FUNCTION assign_native_staff_compatibility_id();

COMMIT;
