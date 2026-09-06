-- Username changes are recorded as distinct provisioning runs by
-- src/jellyfin/provisioning-engine.js. Keep the database action contract in
-- sync so the audit row can be created before the remote Jellyfin rename.

ALTER TABLE public.provisioning_runs
    DROP CONSTRAINT IF EXISTS provisioning_runs_action_check;

ALTER TABLE public.provisioning_runs
    ADD CONSTRAINT provisioning_runs_action_check
    CHECK (action IN (
        'provision',
        'reconcile',
        'disable',
        'password_reset',
        'username_change'
    ));

-- Fail the migration itself if a future edit accidentally omits the action
-- required by renameJellyfinAccount().
DO $$
DECLARE
    constraint_definition text;
BEGIN
    SELECT pg_get_constraintdef(oid)
      INTO constraint_definition
      FROM pg_constraint
     WHERE conrelid = 'public.provisioning_runs'::regclass
       AND conname = 'provisioning_runs_action_check';

    IF constraint_definition IS NULL
       OR position('username_change' IN constraint_definition) = 0 THEN
        RAISE EXCEPTION 'provisioning_runs_action_check must allow username_change';
    END IF;
END
$$;
