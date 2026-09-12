BEGIN;

-- Before 2026-09-12 the access-hold API allowed administrative holds to be
-- persisted without actor_user_id. The application contract was tightened at
-- 2026-09-12 08:32:17 UTC so new admin_disabled/admin_suspended/admin_hold
-- writes using source_key='admin' require an authenticated administrator.
--
-- These historical rows are real blocking authority. Do not release them,
-- fabricate an actor, or rewrite hold_type/source_key: doing any of those would
-- change customer-access semantics. Instead, mark only pre-enforcement active
-- actorless rows with a durable repair marker. The integrity watchdog exempts a
-- row only when both the historical cutoff and this exact marker are present.

WITH target AS (
    SELECT
        h.id,
        h.customer_id,
        h.hold_type,
        h.source_key,
        h.reason
    FROM customer_access_holds h
    WHERE h.released_at IS NULL
      AND h.actor_user_id IS NULL
      AND h.source_key='admin'
      AND h.hold_type IN ('admin_disabled','admin_suspended','admin_hold')
      AND h.created_at < TIMESTAMPTZ '2026-09-12 08:32:17+00'
      AND NOT (
          COALESCE(h.metadata,'{}'::jsonb) @>
          '{"legacyActorlessAdmin": true, "legacyActorRepair": "20260912113000"}'::jsonb
      )
), marked AS (
    UPDATE customer_access_holds h
       SET metadata=COALESCE(h.metadata,'{}'::jsonb) || jsonb_build_object(
               'legacyActorlessAdmin', TRUE,
               'legacyActorRepair', '20260912113000',
               'legacyActorMarkedAt', NOW()
           )
      FROM target t
     WHERE h.id=t.id
     RETURNING
         h.id,
         h.customer_id,
         h.hold_type,
         h.source_key,
         h.reason
)
INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
SELECT
    NULL,
    'customer.access_hold.legacy_actorless_marked',
    'customer',
    m.customer_id,
    jsonb_build_object(
        'holdId', m.id,
        'holdType', m.hold_type,
        'sourceKey', m.source_key,
        'reason', m.reason,
        'repair', '20260912113000',
        'preservedBlockingState', TRUE,
        'preservedAuthorityIdentity', TRUE
    )
FROM marked m;

COMMIT;
