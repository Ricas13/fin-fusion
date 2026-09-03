# Semantic hardening follow-up — 2026-09-03

This follow-up validates the remaining actionable items from the external/Grok review against current `main`.

## Confirmed and fixed

- Restricted discount reservations are now bound to the authoritative checkout intent plan at the PostgreSQL boundary. A caller cannot present a Plan-A code while the underlying checkout intent is for Plan B.
- Integration CI now compares the freshly migrated public table set and `schema_migrations` ledger with the checked-in migration history, detecting missing/unmanaged tables and incomplete migration ledgers.

## Semantic regression

The commerce boundary DB smoke deliberately creates a Plan-B checkout whose caller-facing snapshot and discount request claim Plan A, then proves the restricted Plan-A discount is rejected and leaves no reservation. A correctly bound Plan-A checkout remains valid.

## Findings verified as already covered or stale

- First-run owner setup is serialized and revalidated under database locking.
- Seerr and managed Jellyfin/Emby outbound calls already use call-time destination validation/DNS pinning.
- Destructive restore work starts only after the exclusive maintenance lock; the supported restore wrapper also stops writers.
- Plisio-only means the only supported crypto checkout, not removal of Stripe/PayPal.
- Current source contains no indexed `innerHTML`, `outerHTML`, or `insertAdjacentHTML` sinks.
- Free + paid access overlap, provider checkout identity, late provider settlement, provider-operation idempotency, refund/accounting, discount replay, incident reopening and access-hold semantics already have PostgreSQL-backed regressions.

## Runtime acceptance still outside repository CI

Live proxy-chain verification, production-size `EXPLAIN ANALYZE`, sustained load/soak observation and a real backup-to-clean-restore drill remain deployment acceptance tasks rather than source-only changes.
