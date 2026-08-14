BEGIN;

-- A per-claim lease token so a worker can only complete the EXACT claim it
-- still holds. A plain status='running' check can't tell two different
-- claims on the same item apart once the item cycles back through 'running'
-- a second time (stale reclaim -> admin retry -> re-claim): a late
-- completion from the FIRST (invalidated) claim would otherwise match the
-- SECOND claim's 'running' status and silently resurrect/overwrite it, and
-- double-count background_jobs' progress counters in the process.
ALTER TABLE background_job_items
    ADD COLUMN IF NOT EXISTS claim_token UUID;

COMMIT;
