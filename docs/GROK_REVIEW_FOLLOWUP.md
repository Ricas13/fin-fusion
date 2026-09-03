# External security/reliability review follow-up

This note records the September 2026 external review against the current CAPTAiNFiN codebase. It distinguishes confirmed gaps from findings already addressed by newer code so future reviews do not reintroduce duplicate controls.

## Confirmed and hardened in this change

- **Owner session identity:** owner authorization now treats `authUserId + authRole=admin` as the canonical browser identity and then verifies owner capability from the database. Legacy numeric `adminId` is no longer an authorization prerequisite.
- **Historical migration prefix collisions:** the three known legacy numeric-prefix collisions (`012`, `017`, `045`) are immutable filename identities and are now explicitly grandfathered. CI rejects any new/changed numeric collision; future migrations remain timestamp-identified.
- **Plisio callback protocol:** callback verification remains HMAC-SHA1 over `JSON.stringify(parsedJsonWithoutVerifyHash)` in JSON callback mode, matching Plisio's documented Node example. CI pins a literal signature vector and proves callback keys are not silently sorted.
- **Payment-event replay:** a PostgreSQL behavior test proves concurrent copies of one provider event yield one processing lease, completed events cannot replay, failed events respect the retry delay, and aged failures can be reclaimed with a fresh lease.

## Review findings already covered by current code

- **Impersonation mutation policy is method-level, not route-allowlist based.** Any unsafe `/account` method is denied during impersonation except the explicit exit action. A behavior regression now uses an invented future route so coverage cannot depend on today's route inventory.
- **Provider-operation and checkout identity are already durable/idempotent.** Existing DB suites cover immutable provider checkout identity, provider-operation idempotency conflicts, late provider settlement, frozen discount redemption replay, renewal-credit identity, dispute incident reopening, refunds, entitlement/hold combinations and reconciliation concurrency.
- **Migration application is filename/checksum ledgered and serialized.** Existing deployed filenames cannot safely be renumbered because `schema_migrations.filename` is their historical identity; cleaning the numbers would create more risk than leaving the grandfathered collisions explicit.
- **Plisio completion does not trust callback status alone.** The callback is authenticated, bound to the local checkout transaction, and the remote operation is fetched before access activation.
- **Impersonation already preserves the real admin actor and is read-only across unsafe HTTP methods.**

## Still requiring separate proof or a deliberately scoped change

These should not be changed speculatively inside the payment/auth hardening patch:

1. **Production web DB-role fail-fast.** Supported Docker deployment already uses the restricted app database role. A direct/manual production launch with an owner URL should eventually be rejected by querying PostgreSQL role capabilities before accepting traffic. That needs a startup-contract change because application startup is currently synchronous.
2. **Default CSRF middleware.** Webhooks are mounted before session middleware and can remain exempt, but a global `/admin` + `/account` unsafe-method guard must first inventory tokenless JSON/API flows to avoid breaking valid same-origin clients. Existing route-local CSRF plus Origin/Sec-Fetch checks remain in force until that inventory is complete.
3. **Live/runtime acceptance:** Cloudflare → Traefik → Express client-IP chain, production-sized EXPLAIN ANALYZE, soak/load behavior and a real backup/restore drill cannot be proven by repository-only tests.
4. **Large state-machine extraction:** plan/payment modules should only be split where an explicit state machine and semantic tests improve correctness; file size alone is not a safe refactor reason.
5. **Brand/internal identifier cleanup:** cookie/database/package identifiers are compatibility surfaces and should be migrated intentionally rather than renamed for cosmetic consistency.

## Review rule

For money/access/auth findings, prefer a provider-verified or PostgreSQL behavior test over a source-text assertion. Source ownership tests remain useful for dependency direction and security-boundary wiring, but they are not substitutes for temporal/idempotency behavior tests.
