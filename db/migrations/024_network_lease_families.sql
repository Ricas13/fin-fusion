BEGIN;

ALTER TABLE access_network_leases
    ADD COLUMN IF NOT EXISTS network_family TEXT;

ALTER TABLE access_network_events
    ADD COLUMN IF NOT EXISTS network_family TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname='access_network_leases_family_check'
          AND conrelid='access_network_leases'::regclass
    ) THEN
        ALTER TABLE access_network_leases
            ADD CONSTRAINT access_network_leases_family_check
            CHECK (network_family IS NULL OR network_family IN ('ipv4','ipv6','unknown'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname='access_network_events_family_check'
          AND conrelid='access_network_events'::regclass
    ) THEN
        ALTER TABLE access_network_events
            ADD CONSTRAINT access_network_events_family_check
            CHECK (network_family IS NULL OR network_family IN ('ipv4','ipv6','unknown'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS access_network_leases_subject_family_idx
    ON access_network_leases(tenant_key,scope,subject_key,network_family,expires_at);

COMMENT ON COLUMN access_network_leases.network_family IS
    'Normalized request network family: ipv4, ipv6, or unknown. Household limits are enforced per family so dual-stack homes can use one IPv4 and one IPv6 /64 per household slot.';

COMMENT ON COLUMN access_network_events.network_family IS
    'Network family used for household limit decisions. Does not store raw IP address or prefix.';

COMMIT;
