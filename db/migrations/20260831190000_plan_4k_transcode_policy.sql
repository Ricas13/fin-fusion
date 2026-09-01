BEGIN;

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS kick_4k_transcodes boolean NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN plans.kick_4k_transcodes IS
  'When enabled, confirmed 4K video transcodes for this plan are stopped by the activity policy worker. Direct-play 4K is unaffected.';

COMMIT;
