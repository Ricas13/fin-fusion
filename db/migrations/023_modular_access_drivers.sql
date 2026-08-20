-- Prepare plan enforcement for modular product components while keeping the
-- existing jellyfin/stremio/bundle catalogue fully backward compatible.

ALTER TABLE plans
    ADD COLUMN IF NOT EXISTS jellyfin_access_model TEXT NOT NULL DEFAULT 'concurrent_streams',
    ADD COLUMN IF NOT EXISTS household_network_limit INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS household_lease_minutes INTEGER NOT NULL DEFAULT 240;

-- A stream count is not applicable to household-network Jellyfin plans. NULL is
-- therefore the compatibility-safe representation: the existing stream policy
-- already treats a missing stream limit as "do not enforce concurrent streams".
ALTER TABLE plans ALTER COLUMN streams DROP NOT NULL;

UPDATE plans
SET jellyfin_access_model='concurrent_streams'
WHERE jellyfin_access_model IS NULL
   OR jellyfin_access_model NOT IN ('concurrent_streams','household_network');

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname='plans_jellyfin_access_model_check'
          AND conrelid='plans'::regclass
    ) THEN
        ALTER TABLE plans
            ADD CONSTRAINT plans_jellyfin_access_model_check
            CHECK (jellyfin_access_model IN ('concurrent_streams','household_network'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname='plans_household_network_limit_check'
          AND conrelid='plans'::regclass
    ) THEN
        ALTER TABLE plans
            ADD CONSTRAINT plans_household_network_limit_check
            CHECK (household_network_limit BETWEEN 1 AND 10);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname='plans_household_lease_minutes_check'
          AND conrelid='plans'::regclass
    ) THEN
        ALTER TABLE plans
            ADD CONSTRAINT plans_household_lease_minutes_check
            CHECK (household_lease_minutes BETWEEN 15 AND 1440);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS access_network_leases (
    id BIGSERIAL PRIMARY KEY,
    tenant_key TEXT NOT NULL DEFAULT 'default',
    scope TEXT NOT NULL,
    subject_key TEXT NOT NULL,
    customer_id UUID NULL REFERENCES customers(id) ON DELETE CASCADE,
    network_hash CHAR(64) NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE(tenant_key,scope,subject_key,network_hash)
);

CREATE INDEX IF NOT EXISTS access_network_leases_subject_idx
    ON access_network_leases(tenant_key,scope,subject_key,expires_at);
CREATE INDEX IF NOT EXISTS access_network_leases_expiry_idx
    ON access_network_leases(expires_at);

CREATE TABLE IF NOT EXISTS access_network_events (
    id BIGSERIAL PRIMARY KEY,
    tenant_key TEXT NOT NULL DEFAULT 'default',
    scope TEXT NOT NULL,
    subject_key TEXT NOT NULL,
    customer_id UUID NULL REFERENCES customers(id) ON DELETE SET NULL,
    decision TEXT NOT NULL,
    active_network_count INTEGER,
    network_limit INTEGER,
    lease_expires_at TIMESTAMPTZ,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS access_network_events_subject_idx
    ON access_network_events(tenant_key,scope,subject_key,created_at DESC);
CREATE INDEX IF NOT EXISTS access_network_events_customer_idx
    ON access_network_events(customer_id,created_at DESC);
