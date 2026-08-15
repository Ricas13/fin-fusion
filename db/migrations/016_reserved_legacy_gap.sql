BEGIN;

-- Migration number 016 was never used in the original project history.
-- Keep an explicit no-op reservation so operators and future migrations do not
-- mistake the gap for a missing production change. Existing installations may
-- apply this file after later migrations; it is intentionally side-effect free.
SELECT 1;

COMMIT;
