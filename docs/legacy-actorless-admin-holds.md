# Legacy actorless administrative holds

The customer access-hold API historically allowed administrative holds to be written without an `actor_user_id`. At **2026-09-12 08:32:17 UTC** that contract was tightened so new `admin_disabled`, `admin_suspended`, and `admin_hold` writes using `source_key='admin'` require an authenticated administrator actor.

Historical active rows created before that enforcement point remain valid blocking authority. The repair deliberately does **not** release them, fabricate an administrator, or rewrite `hold_type` / `source_key`. Rewriting those authority columns can change release, display, uniqueness, and future reconciliation behavior.

Migration `20260912113000` therefore adds only an explicit JSON metadata marker:

```json
{
  "legacyActorlessAdmin": true,
  "legacyActorRepair": "20260912113000"
}
```

The integrity watchdog suppresses `actorless_administrative_hold` only when **all** of these conditions are true:

1. the hold was created before `2026-09-12 08:32:17 UTC`;
2. its metadata is a JSON object; and
3. it carries the exact migration marker above.

A pre-enforcement row without the marker still alerts. A row created exactly at or after the enforcement cutoff still alerts even if it somehow carries the marker. Non-object historical metadata is deliberately left untouched and continues to alert for manual review rather than being normalised or discarded. Rows that already contain any of the repair-owned metadata keys are also left untouched unless they already carry the exact valid marker; this prevents the migration from overwriting ambiguous provenance merely to make an alert disappear.

The migration locks eligible rows before updating them so a concurrent release or attribution change cannot race the repair. It also writes an audit event for each row it marks. Existing unrelated metadata is retained, the hold remains active, and its original authority identity is unchanged. The regression smoke executes the migration body inside a rollback-only transaction, verifies idempotence and audit evidence, and proves the watchdog continues to alert on cutoff, malformed-metadata, and ambiguous-marker edge cases.
