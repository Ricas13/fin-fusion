BEGIN;

-- Hard deletion crosses PostgreSQL and one or more remote Jellyfin servers, so
-- it cannot be made atomic with a database transaction. Persist the operation
-- independently of the target customer so a failed/partial run can be retried
-- after remote users have already disappeared.
CREATE TABLE IF NOT EXISTS public.customer_deletion_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL,
    user_id uuid,
    customer_name text,
    customer_email text,
    actor_user_id uuid,
    reason text NOT NULL DEFAULT 'Portal customer deleted by administrator',
    status text NOT NULL DEFAULT 'pending',
    attempt_count integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
    started_at timestamptz,
    access_held_at timestamptz,
    completed_at timestamptz,
    last_error text,
    jellyfin_results jsonb NOT NULL DEFAULT '[]'::jsonb,
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT customer_deletion_jobs_status_check
        CHECK (status IN ('pending','running','failed','succeeded')),
    CONSTRAINT customer_deletion_jobs_attempt_count_check
        CHECK (attempt_count >= 0)
);

-- Only one unfinished deletion may own a customer. A completed job deliberately
-- keeps its snapshot/audit result after the customer and portal user are gone.
CREATE UNIQUE INDEX IF NOT EXISTS customer_deletion_jobs_one_active_customer_idx
    ON public.customer_deletion_jobs(customer_id)
    WHERE status IN ('pending','running','failed');

CREATE INDEX IF NOT EXISTS customer_deletion_jobs_due_idx
    ON public.customer_deletion_jobs(status,next_attempt_at,created_at)
    WHERE status IN ('pending','running','failed');

COMMENT ON TABLE public.customer_deletion_jobs IS
    'Durable cross-system customer hard-deletion saga. Target identifiers are snapshots rather than foreign keys so completed/failed operations survive target deletion.';
COMMENT ON COLUMN public.customer_deletion_jobs.jellyfin_results IS
    'Per-account remote deletion outcomes retained across retries. Local Jellyfin account rows are not removed until all remote identities are confirmed deleted or absent.';

COMMIT;
