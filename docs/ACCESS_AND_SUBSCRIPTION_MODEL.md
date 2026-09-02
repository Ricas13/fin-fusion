# Access and subscription model

This document is the canonical business-behaviour contract for customer access in CAPTAiNFiN. Code may be reorganised, but changes must preserve these invariants unless the product policy is intentionally changed and the associated tests/documentation are updated in the same change.

## Source-of-truth order

Commercial and access decisions follow this direction:

1. **Payment provider state** is external evidence about billing.
2. **`subscriptions` and related billing records** are CAPTAiNFiN's durable commercial contract state.
3. **Entitlement resolution** converts commercial state, paid-through time, permanent access, service scope and active holds into effective access.
4. **Customer reconciliation** converts effective access into desired service state.
5. **Jellyfin, Emby, Stremio delivery, Seerr and Discord** are reconciled external state. They are not commercial entitlement truth.

A remote service being enabled must never create a paid entitlement. A remote service being disabled must never erase a valid subscription.

For Stripe, webhook event payloads are not assumed to be current truth when ordering may be stale; the current provider subscription is retrieved before local state is synchronised.

## Core invariants

### Subscription invariants

- An existing subscription contract remains meaningful even if its catalogue plan is later hidden or retired.
- Paid/trial Jellyfin entitlement takes precedence over the retained Free Server lane when selecting the primary Jellyfin service lane.
- Free Server access is resolved independently and may coexist with a paid Jellyfin entitlement.
- Service-scoped subscriptions must not accidentally replace an entitlement for another service.
- Permanent/grandfathered access survives ordinary period expiry until explicitly revoked.
- Paid-through/service-extension time is part of effective access and must not be replaced by display-price assumptions.
- Imported/grandfathered customers are governed by their stored contract/provider truth, not by the current storefront price.

### Hold invariants

`customer_access_holds` is the canonical access-blocker store. `customers.access_paused_at` and `customers.access_hold_reason` are legacy summary fields only and are synchronised from active typed holds.

- Active holds block access; they do not delete or rewrite the underlying commercial entitlement.
- Hold ownership matters. A subsystem may automatically release only the hold types/source keys it owns and can prove obsolete.
- Inactivity reconciliation may release obsolete inactivity-owned holds.
- Payment, dispute, security or administrator holds must not be silently removed by inactivity reconciliation.
- Administrator release must clear every administrator hold type created by the administrator hold API: `admin_disabled`, `admin_suspended` and `admin_hold`, plus the historical `legacy` compatibility hold.
- Hold creation and release are auditable operations.

### Reconciliation invariants

`src/jellyfin/resilient-provisioning.js` is the canonical customer mutation/reconciliation owner.

- Reconciliation is desired-state convergence, not entitlement creation.
- Reconciliation must first release only provably obsolete inactivity holds and synchronise the legacy hold summary.
- Reconciliation must resolve current entitlement truth after that hold cleanup.
- Paid Jellyfin, Free Jellyfin, Emby, Stremio and Discord state must be considered by the multi-service reconciler.
- Existing healthy service placement is sticky unless a product rule explicitly requires migration; maintenance/drain state primarily affects new placement.
- A successful reconcile result must not be recorded if an entitled Jellyfin lane failed to converge to an enabled account.
- Re-running reconciliation must be safe and must converge toward the same desired state.
- Concurrent reconciliation for the same customer must serialize across web and worker processes using the PostgreSQL advisory lock.
- Calls waiting behind an existing customer reconciliation must run afterwards rather than being coalesced onto the first result, because new holds/payment events may have arrived while the first run was executing.
- Cross-customer reconciliation concurrency is bounded per process so external-service latency cannot consume unbounded dedicated PostgreSQL lock connections.

### External side-effect invariants

PostgreSQL transactions protect internal database invariants. They cannot atomically commit Jellyfin/Discord/Seerr/payment-provider side effects.

Therefore:

- remote creation followed by local persistence failure must compensate where practical;
- provider operations must be idempotent or carry an idempotency key/ledger identity;
- retryable and permanent external failures must be distinguishable;
- reconciliation must be safe to retry after partial failure;
- external HTTP operations require bounded deadlines;
- a best-effort failure that matters operationally must be logged or recorded, not silently swallowed.

## Effective Jellyfin lanes

A customer can have two ordinary Jellyfin lanes:

### Primary lane

The primary lane represents the current non-free Jellyfin/bundle entitlement when one exists. It should own the primary Jellyfin account.

### Free lane

The free lane represents retained Free Server access. It is resolved independently from the paid lane and must not outrank a live paid entitlement merely because a historical free subscription has a far-future/sentinel date.

An account may be adopted into the free lane when historical data predates lane-aware provisioning, provided the adoption rules can identify the appropriate existing account.

## Blocked vs inactive

These states must remain distinct:

- **No entitlement**: there is no commercial/service entitlement for the lane.
- **Entitled but blocked**: a valid entitlement exists, but an active hold prevents access.
- **Entitled and active**: desired state is enabled and reconciliation should converge the service to enabled.
- **Reconciliation failed**: entitlement may be valid, but CAPTAiNFiN could not prove external convergence.

Support/admin UI should prefer these distinctions over a single ambiguous `Active/Disabled` label.

## Cancellation and expiry

Cancellation, expiry and access removal are not interchangeable.

- A cancellation that remains paid through the end of a service period can retain access until effective expiry.
- Expiry state transitions are owned by `src/entitlements/subscription-expiry.js`.
- Reconciliation runs after relevant expiry transitions and converges external state.
- Automatic free-tier downgrade is a separate lifecycle action and must remain retry-safe.
- No route/job should implement an independent ad-hoc subscription-expiry SQL transition.

## Payment event processing

Payment webhook handling must preserve these properties:

- provider signature verification before trust;
- durable provider-event identity for duplicate detection;
- leased/claimable processing state so crashes can be retried;
- idempotent provider mutations where supported;
- current-provider-truth refresh where stale/out-of-order events could otherwise overwrite newer state;
- failed business processing must not be represented as successfully applied merely because the HTTP webhook endpoint was reached.

## Administrator action semantics

The following actions are intentionally different:

- **Reconcile**: recompute desired state and converge services. Does not invent entitlement.
- **Suspend/disable access**: create an administrator-owned access hold and reconcile.
- **Release access**: release administrator-owned holds and reconcile. Does not release unrelated subsystem holds.
- **Cancel/end plan**: change subscription lifecycle state through the canonical billing/lifecycle service, then reconcile.
- **Delete customer**: execute the customer deletion saga, including external cleanup and preservation/anonymisation of records that must survive deletion.

Customer 360 should expose the result of these actions truthfully, including blockers and reconciliation failures.

## Customer 360 state explanation

Where possible, support tooling should show four separate concepts:

1. **Commercial state** — subscriptions, provider, paid-through/permanent access.
2. **Desired access** — effective entitlements by service/lane.
3. **Actual external state** — account/server/service state last observed.
4. **Why** — active holds, reconciliation status, last error and last successful reconciliation.

The reconciler already records structured state that can support this explanation. UI code should consume that state rather than re-deriving business rules independently.

## Architecture ownership

The intended dependency direction is:

```text
payment providers
      ↓
payment lifecycle / subscriptions
      ↓
entitlement state + typed holds
      ↓
resilient-provisioning (canonical customer mutation owner)
      ↓
provisioning-helpers / service-specific reconcilers
      ↓
Jellyfin / Emby / Stremio / Seerr / Discord
```

`src/jellyfin/provisioning.js` is compatibility-only. It may expose low-level helpers and delegate old callers, but it must not independently implement reconciliation, hold mutation or expiry/reconcile composition.

`src/jellyfin/provisioning-helpers.js` is the dependency-safe low-level Jellyfin helper surface. It must not export customer reconciliation, hold mutation or subscription-expiry operations.

## Change-review checklist

Any change touching subscriptions, holds or provisioning should answer all of these before merge:

- What is the source of truth for the state being changed?
- Which invariant above is affected?
- Is this a desired-state calculation or an external side effect?
- Is the operation idempotent/retry-safe?
- What happens if the external call succeeds but the next database operation fails?
- What happens if the same request/event runs twice?
- What happens if two processes run it concurrently?
- Can an older webhook/job overwrite newer truth?
- Could the change release a hold owned by another subsystem?
- Does Customer 360 still explain the resulting state correctly?
- What regression test would fail if this behaviour is accidentally removed later?
