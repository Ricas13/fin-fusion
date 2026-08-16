BEGIN;

ALTER TABLE jellyfin_accounts
    ADD COLUMN IF NOT EXISTS account_purpose TEXT NOT NULL DEFAULT 'jellyfin';

ALTER TABLE jellyfin_accounts
    DROP CONSTRAINT IF EXISTS jellyfin_accounts_account_purpose_check;
ALTER TABLE jellyfin_accounts
    ADD CONSTRAINT jellyfin_accounts_account_purpose_check
    CHECK (account_purpose IN ('jellyfin','stremio_internal'));

CREATE UNIQUE INDEX IF NOT EXISTS jellyfin_accounts_stremio_internal_unique
    ON jellyfin_accounts(customer_id,server_id)
    WHERE account_purpose='stremio_internal';

ALTER TABLE stremio_entitlements
    ADD COLUMN IF NOT EXISTS jellyfin_access_token_encrypted TEXT,
    ADD COLUMN IF NOT EXISTS jellyfin_token_issued_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS install_issued_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_manifest_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_stream_request_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE TABLE IF NOT EXISTS stremio_media_index (
    server_id UUID NOT NULL REFERENCES jellyfin_servers(id) ON DELETE CASCADE,
    imdb_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    item_type TEXT NOT NULL CHECK (item_type IN ('Movie','Series')),
    name TEXT,
    production_year INTEGER,
    path TEXT,
    scan_generation UUID NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(server_id,item_id)
);
CREATE INDEX IF NOT EXISTS stremio_media_index_imdb_idx
    ON stremio_media_index(server_id,imdb_id,item_type);

CREATE TABLE IF NOT EXISTS stremio_media_index_state (
    server_id UUID PRIMARY KEY REFERENCES jellyfin_servers(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'never' CHECK(status IN('never','running','ready','failed')),
    last_started_at TIMESTAMPTZ,
    last_completed_at TIMESTAMPTZ,
    item_count INTEGER NOT NULL DEFAULT 0 CHECK(item_count>=0),
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION enforce_stremio_entitlement_integrity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    sub_customer UUID;
    sub_service TEXT;
    account_customer UUID;
    account_server UUID;
    account_purpose_value TEXT;
    server_allowed BOOLEAN;
BEGIN
    SELECT customer_id,COALESCE(service_type_snapshot,'jellyfin')
      INTO sub_customer,sub_service
      FROM subscriptions WHERE id=NEW.subscription_id;
    IF sub_customer IS NULL OR sub_customer<>NEW.customer_id THEN
        RAISE EXCEPTION 'Stremio subscription/customer mismatch';
    END IF;
    IF sub_service NOT IN ('stremio','bundle') THEN
        RAISE EXCEPTION 'Stremio entitlement requires a stremio or bundle subscription';
    END IF;

    IF NEW.status<>'revoked' AND NEW.server_id IS NOT NULL THEN
        SELECT stremio_enabled INTO server_allowed FROM jellyfin_servers WHERE id=NEW.server_id;
        IF COALESCE(server_allowed,FALSE)=FALSE THEN
            RAISE EXCEPTION 'Assigned Jellyfin server is not enabled for Stremio';
        END IF;
    END IF;

    IF NEW.jellyfin_account_id IS NOT NULL THEN
        SELECT customer_id,server_id,account_purpose
          INTO account_customer,account_server,account_purpose_value
          FROM jellyfin_accounts WHERE id=NEW.jellyfin_account_id;
        IF account_customer IS NULL OR account_customer<>NEW.customer_id OR account_server IS DISTINCT FROM NEW.server_id THEN
            RAISE EXCEPTION 'Stremio Jellyfin account ownership/server mismatch';
        END IF;
        IF account_purpose_value<>'stremio_internal' THEN
            RAISE EXCEPTION 'Stremio entitlement requires a dedicated internal Jellyfin account';
        END IF;
    END IF;

    IF NEW.status='active' AND (
        NEW.server_id IS NULL OR NEW.jellyfin_account_id IS NULL OR NEW.token_hash IS NULL OR
        NEW.jellyfin_access_token_encrypted IS NULL
    ) THEN
        RAISE EXCEPTION 'Active Stremio entitlement is incomplete';
    END IF;
    IF NEW.status='revoked' AND NEW.revoked_at IS NULL THEN
        NEW.revoked_at:=NOW();
    ELSIF NEW.status<>'revoked' THEN
        NEW.revoked_at:=NULL;
    END IF;
    NEW.updated_at:=NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stremio_entitlement_integrity_trigger ON stremio_entitlements;
CREATE TRIGGER stremio_entitlement_integrity_trigger
BEFORE INSERT OR UPDATE ON stremio_entitlements
FOR EACH ROW EXECUTE FUNCTION enforce_stremio_entitlement_integrity();

COMMIT;
