BEGIN;

-- Upgrade bridge for deployments that already contain subscriptions created
-- through customer invitations before migration 036 rebuilt the source CHECK.
--
-- Migration 022 made source='invitation' valid. Migration 036 historically
-- omitted that value, so an existing installation with invitation subscriptions
-- could not reach the later repair migration. Preserve the exact affected row
-- IDs, move only those rows to an already-valid temporary classification, then
-- 036a restores them immediately after migration 036 completes.
CREATE TABLE IF NOT EXISTS migration_036_invitation_source_bridge (
    subscription_id UUID PRIMARY KEY
);

INSERT INTO migration_036_invitation_source_bridge(subscription_id)
SELECT id
FROM subscriptions
WHERE source='invitation'
ON CONFLICT(subscription_id) DO NOTHING;

UPDATE subscriptions s
SET source='migration'
FROM migration_036_invitation_source_bridge b
WHERE s.id=b.subscription_id
  AND s.source='invitation';

COMMIT;
