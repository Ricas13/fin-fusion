BEGIN;

-- Zero capacity is an explicit operator-controlled launch state: the plan may be
-- fully configured and visible, but no new acquisition is permitted until the
-- administrator opens one or more slots. NULL retains its historical meaning
-- of no configured capacity limit.
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_capacity_limit_check;
ALTER TABLE plans ADD CONSTRAINT plans_capacity_limit_check
    CHECK (capacity_limit IS NULL OR capacity_limit >= 0);

COMMIT;
