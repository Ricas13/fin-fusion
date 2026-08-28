BEGIN;

-- `awaiting_checkout` is still an open customer decision. Clean up any
-- duplicates created between migration 102 and this constraint, keeping the
-- newest customer intent, then enforce one open plan change per customer.
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY customer_id
               ORDER BY created_at DESC, id DESC
           ) AS rn
    FROM customer_plan_changes
    WHERE state IN ('pending','awaiting_checkout')
)
UPDATE customer_plan_changes pc
SET state='cancelled',
    error=COALESCE(pc.error,'Superseded by a newer open plan change during migration 103.'),
    updated_at=NOW()
FROM ranked r
WHERE pc.id=r.id AND r.rn>1;

DROP INDEX IF EXISTS customer_plan_changes_one_pending;
DROP INDEX IF EXISTS customer_plan_changes_one_open;
CREATE UNIQUE INDEX customer_plan_changes_one_open
    ON customer_plan_changes(customer_id)
    WHERE state IN ('pending','awaiting_checkout');

COMMIT;
