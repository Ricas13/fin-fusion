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

The integrity watchdog suppresses `actorless_administrative_hold` only when **both** conditions are true:

1. the hold was created before `2026-09-12 08:32:17 UTC`; and
2. the hold carries the exact migration marker above.

A pre-enforcement row without the marker still alerts. A post-enforcement actorless row still alerts even if it somehow carries the marker. This keeps the exception narrow and preserves detection of genuinely new attribution failures.

The migration also writes an audit event for each row it marks. Existing metadata is retained, the hold remains active, and its original authority identity is unchanged.
