BEGIN;

-- Migration 051_attention_workflow.sql was superseded immediately by
-- 052_attention_state_and_references.sql. No application code reads or writes
-- attention_workflow; keeping it only creates two competing mental models for
-- the Needs Attention feature.
DROP TABLE IF EXISTS attention_workflow;

COMMIT;
