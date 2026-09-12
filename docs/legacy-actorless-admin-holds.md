# Legacy actorless administrative holds

The customer access-hold API historically allowed administrative holds to be written without an `actor_user_id`. On 2026-09-12 that contract was tightened so new `admin_disabled`, `admin_suspended`, and `admin_hold` writes using `source_key='admin'` require an authenticated administrator actor.

Existing active rows created before that enforcement point are preserved as blocking authority, but are reclassified as `legacy` holds with their original hold type/source retained in metadata. This avoids treating historical unattributed state as a fresh integrity violation while keeping ordinary administrator Enable/restore semantics intact.
