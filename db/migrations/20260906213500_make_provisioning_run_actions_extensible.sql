-- provisioning_runs.action is an audit/event vocabulary, not a closed product enum.
-- Keeping a hard-coded list here makes otherwise valid application changes capable
-- of breaking all customer reconciliation. Validate shape instead of enumerating
-- every legitimate action name.

ALTER TABLE public.provisioning_runs
    DROP CONSTRAINT IF EXISTS provisioning_runs_action_check;

ALTER TABLE public.provisioning_runs
    ADD CONSTRAINT provisioning_runs_action_check
    CHECK (
        action IS NOT NULL
        AND length(btrim(action)) BETWEEN 1 AND 100
        AND action ~ '^[a-z0-9_]+$'
    ) NOT VALID;

-- Customers that failed only because the old action enum rejected a legitimate
-- provisioning run should not sit in exponential backoff after this migration.
-- Make those rows due immediately and clear only this specific stale failure.
UPDATE public.customer_provisioning_state
SET status = 'pending',
    consecutive_failures = 0,
    last_error = NULL,
    next_attempt_at = NOW(),
    updated_at = NOW()
WHERE status = 'failed'
  AND last_error ILIKE '%provisioning_runs_action_check%';

-- Guard the migration contract itself. This fails deployment if a future edit
-- accidentally restores an enumerated action list instead of the shape check.
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
       OR position('length(btrim(action))' IN lower(constraint_definition)) = 0
       OR position('action ~' IN lower(constraint_definition)) = 0 THEN
        RAISE EXCEPTION 'provisioning_runs_action_check must validate action shape without enumerating action names';
    END IF;
END;
$$;
