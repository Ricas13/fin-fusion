# Legacy actorless administrative holds

The customer access-hold API historically allowed administrative holds to be written without an `actor_user_id`. At **2026-09-12 08:32:17 UTC** that contract was tightened so new `admin_disabled`, `admin_suspended`, and `admin_hold` writes using `source_key='admin'` require an authenticated administrator actor.

Historical active rows created before that enforcement point remain valid blocking authority. The repair deliberately does **not** release them, fabricate an administrator, or rewrite `hold_type` / `source_key`. Rewriting those authority columns can change release, display, uniqueness, and future reconciliation behavior.

Migration `20260912113000` adds only explicit JSON metadata identifying the one-time historical repair:

```json
{
  "legacyActorlessAdmin": true,
  "legacyActorRepair": "20260912113000",
  "legacyActorMarkedAt": "<migration timestamp>"
}
```

The integrity watchdog suppresses `actorless_administrative_hold` only when **all** of these conditions are true:

1. the hold was created before `2026-09-12 08:32:17 UTC`;
2. its metadata is a JSON object;
3. it carries the exact repair flag and repair version above;
4. it has a non-empty `legacyActorMarkedAt`; and
5. `audit_log` contains the matching `customer.access_hold.legacy_actorless_marked` repair event for that exact customer and hold, with the same repair version and explicit evidence that blocking state and authority identity were preserved.

The audit requirement is deliberate: metadata by itself is not trusted as proof that the migration authored the exemption. A pre-enforcement row with copied, forged, incomplete, or ambiguous marker metadata still alerts unless the matching migration audit evidence exists. A row created exactly at or after the enforcement cutoff still alerts even if it somehow carries both marker metadata and audit-like data.

Non-object historical metadata is deliberately left untouched and continues to alert for manual review rather than being normalised or discarded. Rows that already contain any of the repair-owned metadata keys are also left untouched, so ambiguous provenance is never overwritten merely to make an alert disappear.

The migration locks eligible rows before updating them so a concurrent release or attribution change cannot race the repair. It writes one audit event for each row it marks. Existing unrelated metadata is retained, the hold remains active, and its original authority identity is unchanged.

The rollback-only regression smoke executes the migration body twice to prove idempotence, verifies the matching audit evidence, checks that marker-only rows still alert, covers cutoff and malformed-metadata cases, and exercises targeted `admin_disabled` / `admin_suspended` release semantics to prove the original authority identities still behave correctly.
