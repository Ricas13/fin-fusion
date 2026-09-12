BEGIN;

-- Before 2026-09-12 the access-hold API allowed administrative holds to be
-- persisted without actor_user_id. The integrity watchdog added on 2026-09-12
-- correctly treats that shape as invalid for new writes, but existing rows are
-- historical state rather than fresh unaudited administrator mutations.
--
-- Preserve every hold and its blocking/release semantics. Reclassify only the
-- pre-enforcement actorless administrative rows as legacy authority, retain the
-- original type/source in metadata, and append an audit entry for the repair.
-- releaseAllAdminHolds() intentionally includes hold_type='legacy', so ordinary
-- administrator Enable/restore controls continue to release these holds.

WITH target AS (
    SELECT
        h.id,
        h.customer_id,
        h.hold_type AS original_hold_type,
        h.source_key AS original_source_key,
        h.reason
    FROM customer_access_holds h
    WHERE h.released_at IS NULL
      AND h.actor_user_id IS NULL
      AND h.source_key='admin'
      AND h.hold_type IN ('admin_disabled','admin_suspended','admin_hold')
      AND h.created_at < TIMESTAMPTZ '2026-09-12 08:32:17+00'
), repaired AS (
    UPDATE customer_access_holds h
       SET hold_type='legacy',
           source_key='legacy:' || t.original_hold_type,
           metadata=COALESCE(h.metadata,'{}'::jsonb) || jsonb_build_object(
               'legacyActorUnattributed', TRUE,
               'legacyOriginalHoldType', t.original_hold_type,
               'legacyOriginalSourceKey', t.original_source_key,
               'legacyReclassifiedAt', NOW()
           )
      FROM target t
     WHERE h.id=t.id
     RETURNING
         h.id,
         h.customer_id,
         t.original_hold_type,
         t.original_source_key,
         t.reason
)
INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
SELECT
    NULL,
    'customer.access_hold.legacy_reclassified',
    'customer',
    r.customer_id,
    jsonb_build_object(
        'holdId', r.id,
        'originalHoldType', r.original_hold_type,
        'originalSourceKey', r.original_source_key,
        'reason', r.reason,
        'origin', 'legacy-unattributed',
        'preservedBlockingState', TRUE
    )
FROM repaired r;

COMMIT;
