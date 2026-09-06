-- The username-change migration narrowed provisioning_runs.action to the
-- original Jellyfin-only values. Multi-service reconciliation already records
-- Emby work as emby_reconcile / emby_disable, so retain those established
-- audit actions as well. This is independent of the Jellyfin lifecycle: managed
-- Jellyfin identities remain present+enabled or deleted.

ALTER TABLE public.provisioning_runs
    DROP CONSTRAINT IF EXISTS provisioning_runs_action_check;

ALTER TABLE public.provisioning_runs
    ADD CONSTRAINT provisioning_runs_action_check
    CHECK (action IN (
        'provision',
        'reconcile',
        'disable',
        'password_reset',
        'username_change',
        'emby_reconcile',
        'emby_disable'
    ));

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
       OR position('username_change' IN constraint_definition) = 0
       OR position('emby_reconcile' IN constraint_definition) = 0
       OR position('emby_disable' IN constraint_definition) = 0 THEN
        RAISE EXCEPTION 'provisioning_runs_action_check is missing a supported provisioning action';
    END IF;
END
$$;
