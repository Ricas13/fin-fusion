BEGIN;

-- A Jellyfin account created by CAPTAiNFiN starts with an intentionally
-- unexposed random bootstrap password. Mark only those freshly provisioned
-- identities so the customer must choose their own password before the portal
-- treats setup as complete. Existing/imported Jellyfin accounts insert with
-- last_policy_sync NULL and keep their current password untouched.
ALTER TABLE jellyfin_accounts
    ADD COLUMN IF NOT EXISTS password_setup_required BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION mark_fresh_jellyfin_password_setup()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.last_policy_sync IS NOT NULL THEN
        NEW.password_setup_required := TRUE;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS mark_fresh_jellyfin_password_setup_trigger ON jellyfin_accounts;
CREATE TRIGGER mark_fresh_jellyfin_password_setup_trigger
BEFORE INSERT ON jellyfin_accounts
FOR EACH ROW EXECUTE FUNCTION mark_fresh_jellyfin_password_setup();

CREATE INDEX IF NOT EXISTS jellyfin_accounts_password_setup_idx
    ON jellyfin_accounts(customer_id)
    WHERE password_setup_required=TRUE;

COMMIT;
