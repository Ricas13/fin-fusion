BEGIN;

-- Household-network plans intentionally do not use concurrent stream counts.
-- Every other access model must retain a positive stream limit so malformed or
-- legacy configuration can never silently disable concurrent-stream policy.
UPDATE plans
SET streams = 1
WHERE jellyfin_access_model = 'concurrent_streams'
  AND streams IS NULL;

UPDATE plans
SET streams = NULL
WHERE jellyfin_access_model = 'household_network'
  AND streams IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'plans_jellyfin_stream_contract_check'
          AND conrelid = 'plans'::regclass
    ) THEN
        ALTER TABLE plans
            ADD CONSTRAINT plans_jellyfin_stream_contract_check
            CHECK (
                (jellyfin_access_model = 'household_network' AND streams IS NULL)
                OR
                (jellyfin_access_model = 'concurrent_streams' AND streams IS NOT NULL AND streams > 0)
            );
    END IF;
END $$;

-- PostgreSQL does not automatically index the referencing side of a foreign
-- key. Customer deletion and lease cleanup both filter on this column.
CREATE INDEX IF NOT EXISTS access_network_leases_customer_idx
    ON access_network_leases(customer_id);

-- audit_log is append-only. Runtime roles only need SELECT/INSERT; retaining
-- UPDATE/DELETE made the trigger's session escape hatch broader than necessary.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'steamfusion_app') THEN
        REVOKE UPDATE, DELETE ON TABLE public.audit_log FROM steamfusion_app;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'steamfusion_automation') THEN
        REVOKE UPDATE, DELETE ON TABLE public.audit_log FROM steamfusion_automation;
    END IF;
END $$;

COMMIT;
