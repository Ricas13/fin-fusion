BEGIN;

-- Emby is a first-class primary service lane. The plan constraint was widened
-- when Emby Share was introduced, but the immutable subscription snapshot
-- constraint was not, so valid Emby subscriptions could fail at INSERT time.
ALTER TABLE public.subscriptions
    DROP CONSTRAINT IF EXISTS subscriptions_service_type_snapshot_check;

ALTER TABLE public.subscriptions
    ADD CONSTRAINT subscriptions_service_type_snapshot_check
    CHECK (service_type_snapshot IN ('jellyfin','stremio','emby','bundle'));

-- provisioning_runs.action is an audit/event vocabulary, not a closed product
-- enum. A later compatibility migration accidentally restored an enumerated
-- list after this had already been made extensible. Validate the action shape
-- instead so new legitimate reconciliation actions cannot brick provisioning.
ALTER TABLE public.provisioning_runs
    DROP CONSTRAINT IF EXISTS provisioning_runs_action_check;

ALTER TABLE public.provisioning_runs
    ADD CONSTRAINT provisioning_runs_action_check
    CHECK (
        action IS NOT NULL
        AND length(btrim(action)) BETWEEN 1 AND 100
        AND action ~ '^[a-z0-9_]+$'
    ) NOT VALID;

-- Requeue customers that were stranded only by either stale check constraint.
UPDATE public.customer_provisioning_state
SET status='pending',
    consecutive_failures=0,
    last_error=NULL,
    next_attempt_at=NOW(),
    updated_at=NOW()
WHERE status='failed'
  AND (
      last_error ILIKE '%subscriptions_service_type_snapshot_check%'
      OR last_error ILIKE '%provisioning_runs_action_check%'
  );

DO $$
DECLARE
    subscription_constraint text;
    action_constraint text;
BEGIN
    SELECT pg_get_constraintdef(oid)
      INTO subscription_constraint
      FROM pg_constraint
     WHERE conrelid='public.subscriptions'::regclass
       AND conname='subscriptions_service_type_snapshot_check';

    IF subscription_constraint IS NULL
       OR position('emby' IN lower(subscription_constraint))=0 THEN
        RAISE EXCEPTION 'subscriptions_service_type_snapshot_check must allow emby';
    END IF;

    SELECT pg_get_constraintdef(oid)
      INTO action_constraint
      FROM pg_constraint
     WHERE conrelid='public.provisioning_runs'::regclass
       AND conname='provisioning_runs_action_check';

    IF action_constraint IS NULL
       OR position('length(btrim(action))' IN lower(action_constraint))=0
       OR position('action ~' IN lower(action_constraint))=0 THEN
        RAISE EXCEPTION 'provisioning_runs_action_check must validate action shape without enumerating action names';
    END IF;
END;
$$;

COMMIT;
