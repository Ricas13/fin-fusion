-- Historical administrative holds created before administrator-actor enforcement
-- are still valid access blockers, but they must not masquerade as authenticated
-- admin actions forever. Reclassify only the currently active legacy rows while
-- preserving the original source in metadata. This does not release any hold or
-- otherwise change customer access.
UPDATE customer_access_holds
SET source_key = 'legacy_admin_unattributed',
    metadata = COALESCE(metadata, '{}'::jsonb)
        || jsonb_build_object(
            'provenance', 'legacy_unattributed_admin_hold',
            'legacy_source_key', source_key,
            'provenance_migrated_at', NOW()
        )
WHERE released_at IS NULL
  AND actor_user_id IS NULL
  AND source_key = 'admin'
  AND hold_type IN ('admin_disabled', 'admin_suspended', 'admin_hold');

-- The application already rejects new actorless source_key=admin holds. Enforce
-- the same invariant in PostgreSQL as defense in depth so a future direct write,
-- worker regression, or maintenance script cannot recreate this state.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'customer_access_holds_active_admin_actor_check'
          AND conrelid = 'customer_access_holds'::regclass
    ) THEN
        ALTER TABLE customer_access_holds
            ADD CONSTRAINT customer_access_holds_active_admin_actor_check
            CHECK (
                released_at IS NOT NULL
                OR actor_user_id IS NOT NULL
                OR source_key <> 'admin'
                OR hold_type NOT IN ('admin_disabled', 'admin_suspended', 'admin_hold')
            );
    END IF;
END
$$;

COMMENT ON CONSTRAINT customer_access_holds_active_admin_actor_check ON customer_access_holds IS
    'Active admin_disabled/admin_suspended/admin_hold rows with source_key=admin require an authenticated administrator actor. Legacy unattributed rows are reclassified without releasing access.';
